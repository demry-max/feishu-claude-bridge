# Deploy, recovery, and rollback

Local operations only. Do not point this at production from a cloud agent, do not send Feishu messages from CI, and do not copy `.env`, `data/`, `workspace/`, or logs into git.

The running app is `feishu-grok-bridge` 1.1: stdin NDJSON in, one 15s `fetch` out. 1.2.0 replaces that POST path with a durable queue. The Claude bridge at the repository root stays as it is. The supervisor still owns lark-cli and still writes raw events into its own SQLite **before** this process. That supervisor replay stays off.

## What 1.2.0 guarantees

Not exactly-once. The receiver has to be idempotent before any ambiguous wake is sent again.

| Outcome | What we know | What the bridge does |
|---|---|---|
| HTTP 2xx | Receiver accepted this attempt | `delivered`. DONE + progress `✅ 已唤醒`. Never sent again. |
| 429, 425, 500, 502, 503, other 5xx except 501 and 504 | Receiver or gateway explicitly failed, or the TCP connection never completed (`ECONNREFUSED`, DNS) | Retry with capped backoff. Then `dead`. Progress `⚠️ 唤醒失败`. |
| Client timeout, `ECONNRESET`, HTTP 408, 504, 409 | The wake may already have run | `ambiguous`. Not `delivered`. Not retried. Progress `⏳ 结果不确定`. |
| Crash after the attempt was marked in flight and before the result was written | Same as a timeout | Next start converts `inflight` → `ambiguous`. Does not POST. |
| Crash before the attempt was marked in flight (`queued`, including a crash while the progress bubble was still being created) | The POST was not started | Next start sends it once. |

Default budget: timeout 15s (unchanged), 6 attempts, backoff 1s, 2s, 4s… capped at 60s, jitter ±20%, `Retry-After` honored only up to that cap. A chat does not POST a later message while an earlier one in that chat is still `queued` or `inflight`. After the earlier job is terminal (`delivered`, `dead`, `ambiguous`, `discarded`), later messages proceed. Replaying an old ambiguous job can therefore arrive after newer ones.

Dedupe is the on-disk `message_id`, not a 1000-entry memory set. A Feishu redelivery does not create a second OnIt, progress bubble, or POST. Deleting `data/delivery` makes every old `message_id` look new.

## Files to keep

On the box, config and user data stay at the existing app directory (`/workspace/feishu-grok-bridge` in the last layout). Keep:

- `.env` (mode 600). Do not print it. New variables are optional.
- `data/` including `owner.json`
- `workspace/` and `workspace-guest/`
- `bin/start.sh` if the supervisor still calls it
- the supervisor unit and its SQLite. Do not enable backlog replay.

Copy only the new `src/`, `package.json`, `README.md`, and `DEPLOY.md` over the app tree. Do not delete the directory. Do not `npm install` the Claude bridge's dependencies into this app: 1.2.0 uses Node built-ins only. Node 18 or newer.

`data/delivery/` is created on first start. Job files are mode 600 and contain the webhook JSON, including message text, because a retry has to send the same body. They do not contain `GROK_WEBHOOK_KEY`. `status` output omits the body. Do not commit this directory.

## Optional environment

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_TIMEOUT_MS` | `15000` | Unchanged single-attempt budget. Invalid values are ignored and not logged. |
| `WEBHOOK_MAX_ATTEMPTS` | `6` | Includes the first try. Range 1–10. |
| `WEBHOOK_BACKOFF_BASE_MS` | `1000` | First retry delay before jitter. |
| `WEBHOOK_BACKOFF_CAP_MS` | `60000` | Ceiling, including `Retry-After`. |
| `WEBHOOK_RETRY_AMBIGUOUS` | off | `true` or `1` retries timeouts and similar results. Can duplicate work. Leave off until the receiver dedupes. |
| `WEBHOOK_IDEMPOTENCY_HEADER` | on | Sends `Idempotency-Key: <message_id>`. Set `false` if a strict receiver rejects the extra header. The body `message_id` is always there. |
| `WEBHOOK_MAX_PAYLOAD_BYTES` | `262144` | Larger bodies are dead-lettered and not POSTed. |
| `DELIVERY_POLL_MS` | `500` | How often a running process looks for due jobs and operator commands. |
| `DELIVERY_SHUTDOWN_GRACE_MS` | `20000` | On SIGTERM/SIGINT, wait this long for the in-flight POST to finish persisting, then exit 1. Retries that are only scheduled are left on disk. |
| `DELIVERY_DIR` | `data/delivery` | Queue directory. |

`X-Delivery-Attempt` is sent on every POST. User-Agent stays `feishu-grok-bridge/1.1`.

## Install

1. Stop the supervisor so only one Node bridge is running. Do not SIGKILL it if a POST is in flight and you can wait; SIGTERM is enough. 1.1 exits in about half a second and can leave a wake that the server already accepted. That is the same ambiguity 1.2.0 refuses to auto-retry. Do not replay the supervisor SQLite to "finish" those.
2. Copy 1.2.0 sources over the app as described above. Leave `.env` and data in place.
3. Confirm the supervisor stop timeout is at least 25 seconds so 1.2.0 can persist the in-flight result. A shorter kill turns that attempt into `ambiguous` on the next start, and it will not be POSTed again by itself.
4. Start one bridge process the same way as before (stdin from lark-cli). Do not also start 1.1. Do not start a second 1.2.0 on the same `data/delivery`.
5. Boot log should contain `delivery=durable` and `timeout_ms=15000`, and must not contain the webhook key or the full URL.
6. `node src/delivery-admin.js status --dir <data/delivery>` should show the directory present and `inflight` at 0 once the process is idle. `status` does not POST and does not rewrite an in-flight job. `--fail-on-held` exits 2 when `ambiguous`, `dead`, or `inflight` is non-zero.

## One real Feishu check

Required after install. Send one new DM from the owner account. Do not replay history.

- The bot adds OnIt and a `处理中` bubble.
- The routine receives one POST whose JSON keys match 1.1, including `message_id`, `session_key`, `progress_message_id`, `workspace_dir`, `outbox_dir`.
- After HTTP 2xx, the bubble becomes `✅ 已唤醒` and DONE is added.
- The log line `[webhook] ok status=200` is present, and `status` shows that `message_id` as `delivered`.
- Sending the same event again (supervisor duplicate, not a second human message) does not POST a second time.

Do not test auto-retry by pointing the URL at a black hole unless that URL is a local stub. A real 15s timeout against the routine is exactly the ambiguous case: if you do it once, expect `ambiguous` and no automatic second POST.

## Coordination before any replay

The parent routine must treat body `message_id` (and `Idempotency-Key`, if the header is on) as an idempotency key **before** it does anything the user can observe: replies, tool calls, file writes, downstream POSTs.

Until that is true:

- Leave `WEBHOOK_RETRY_AMBIGUOUS` unset.
- Do not `replay` a job whose `last_outcome` is `timeout`, `crash_inflight`, `http_408`, `http_504`, `http_409`, `ECONNRESET`, or `unknown_network`.
- `discard` never POSTs. Use it to drop a queued job you have decided not to send, or to retire an ambiguous job you know already ran (for example the routine returned 409 because it already had that `message_id`). Discarding does not tell the routine anything.
- A human sending a new message is a new `message_id`. That is safe relative to the queue. It still duplicates the original wake if the original POST actually arrived.

`replay` and `discard` only write `data/delivery/commands/*.json`. The running bridge applies them. If the bridge is stopped, they apply on the next start, before new sends. `replay` of an ambiguous job resets the attempt budget and POSTs again.

Definite failures (`dead` / `exhausted` / `poison`) are safe to replay only when you believe the receiver did not run the wake. A 400 will simply poison again. A 503 that later recovered is a reasonable replay.

## Recovery

- `queued` with `attempts` 0 after a restart: will be sent. This includes a crash between accept and the progress bubble. The bubble id may be null. OnIt is not repeated.
- `inflight` after a restart: `ambiguous`, not sent. The user is told the result is uncertain if that notice was not already finished.
- `delivered` with the Feishu update unfinished: the POST is not repeated; the progress/DONE update is tried again.
- `status` counts: `queued`, `queued_ready`, `queued_waiting`, `inflight`, `ambiguous`, `delivered`, `dead`, `skipped`, `discarded`. Boot logs the same counts without message text.
- Two writers corrupt the queue. Only the bridge writes job files. `status` is safe while it runs. Do not run `openStore` from a second Node process.

The supervisor's SQLite is a separate log. Turning on its replay would feed old `message_id`s into an empty 1.2.0 dedupe set and wake Grok again for each of them, with new OnIt and progress bubbles. Keep that replay disabled.

## Rollback

1. Stop the supervisor and the 1.2.0 process. Wait until it has exited. Do not leave 1.1 and 1.2.0 both running.
2. Move `data/delivery` to `data/delivery.held-<timestamp>`. 1.1 ignores it, but a later upgrade would send any `queued` jobs still in it, including ones the user already replaced by sending a new message.
3. Restore the 1.1 `src/` and `package.json` from the previous tree. Keep `.env`, `data/owner.json`, `workspace/`, `workspace-guest/`, and `bin/`.
4. Start 1.1 the usual way. It goes back to one 15s fetch and memory dedupe. It will not finish 1.2.0's `ambiguous` or `queued` jobs. Those users send a new message if they still need a reply.
5. To roll forward again, install 1.2.0 with a fresh `data/delivery` unless you have checked the held directory and intentionally want its not-yet-sent `queued` jobs. Do not restore `ambiguous` jobs into a live directory unless the receiver now dedupes and you mean to replay them.

## Residual risks

- Exactly-once is impossible from this process alone. A timeout plus a later human resend, or a timeout plus `replay`, can run the routine twice until it dedupes.
- A crash in the small window after DONE is sent and before `ux_done` is written can react DONE twice. The webhook is not sent twice.
- HTTP 409 is held, not treated as success. If 409 means "already accepted", discard the job instead of replaying it, or the user may be told the result is uncertain and send a second message.
- Unknown fetch errors are held rather than retried, so a programming error cannot hot-loop. They show up as `ambiguous` / `unknown_network`.
- Dedupe records are not pruned. The directory grows by one small file per accepted message. Removing it reopens duplicate wakes.
- 1.2.0 waits up to 20s on SIGTERM instead of 1.1's 0.5s, and only for the in-flight attempt. Scheduled retries are not waited out. A supervisor that still SIGKILLs at 0.5s leaves an `ambiguous` job.
- While an earlier message in a chat is waiting for backoff, a later message in that chat can already show OnIt. The POST order stays per chat. That is narrower than 1.1, which held the whole chat queue inside the single 15s fetch and failed immediately.
- Group messages without an @mention, denied users, `/help`, `/ping`, and empty text are tombstoned and not woken. That matches 1.1's in-memory dedupe, and it now survives a restart.

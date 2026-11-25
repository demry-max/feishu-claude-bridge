# feishu-grok-bridge

Feishu to Grok Bot webhook bridge. The chat UX matches the deployed 1.1 bridge: owner/guest split, @mention, OnIt, progress bubble, session and outbox paths. Version 1.2.0 adds a durable webhook outbox.

This is not the Claude websocket bridge in the repository root.

## Flow

1. lark-cli (owned by the supervisor) writes one JSON event per line to this process's stdin.
2. Dedupe by `message_id`, allowlist, @mention, then a per-chat accept queue.
3. Immediate OnIt and a progress reply.
4. The wake is stored, then POSTed. HTTP 2xx updates the progress bubble and adds DONE.
5. Grok replies later via lark-cli. This process does not wait for that text.

## Delivery guarantee

Not exactly-once.

- HTTP 2xx is the only delivered state.
- HTTP 429, 425, and most 5xx, plus connection refused / DNS failure, are retried with capped backoff (default 6 attempts, 1s base, 60s cap) and then dead-lettered.
- Client timeout, connection reset, HTTP 408 / 504 / 409, and a crash while a request is in flight are `ambiguous`. They are not marked delivered and are not retried unless `WEBHOOK_RETRY_AMBIGUOUS=true` or an operator runs `replay`. Either one can duplicate work if the receiver does not dedupe `message_id`.

The JSON body fields are the 1.1 set. `Idempotency-Key` and `X-Delivery-Attempt` are extra headers. Set `WEBHOOK_IDEMPOTENCY_HEADER=false` to drop `Idempotency-Key`.

## Run

The supervisor starts lark-cli and this process. This package does not open a Feishu connection.

```bash
node src/index.js
```

Stdin is NDJSON from `lark-cli event consume`. `.env` in this directory overrides the environment for keys it sets. Do not print `.env`.

## Queue

```bash
node src/delivery-admin.js status --dir "$DELIVERY_DIR"
node src/delivery-admin.js replay --dir "$DELIVERY_DIR" --message-id om_...
node src/delivery-admin.js discard --dir "$DELIVERY_DIR" --message-id om_...
```

`status` is read-only. `replay` and `discard` only write a command file; the bridge applies it on its next pass and is the only process that POSTs. See [DEPLOY.md](DEPLOY.md) before replaying anything ambiguous.

## Test

```bash
node --test --test-concurrency=1 test/*.test.js
```

No network, no Feishu, no credentials.

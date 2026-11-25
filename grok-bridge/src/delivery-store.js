/**
 * Single-writer durable queue.
 *
 * One JSON file per job, replaced by write + fsync + rename. The bridge process
 * is the only writer of job files. Operators enqueue replay/discard by dropping
 * a command file; they must not open the store for recovery while the bridge
 * is running (that would rewrite an in-flight job).
 *
 * `readSnapshot` is read-only and safe to run against a live directory.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STORE_VERSION = 1;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function atomicWrite(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* directory fsync is best-effort */ }
}

function idFileName(messageId) {
  const s = String(messageId);
  if (/^[A-Za-z0-9._:-]{1,200}$/.test(s)) return s;
  return `h_${crypto.createHash('sha256').update(s).digest('hex')}`;
}

export function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    message_id: job.message_id,
    chat_id: job.chat_id,
    kind: job.kind,
    state: job.state,
    ready: job.ready,
    seq: job.seq,
    attempts: job.attempts,
    last_outcome: job.last_outcome,
    last_status: job.last_status,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    next_attempt_at: job.next_attempt_at,
    delivered_at: job.delivered_at,
    ux_pending: job.ux_pending,
    ux_done: job.ux_done,
    reason: job.reason || null,
  };
}

function emptyCounts() {
  return {
    queued: 0,
    queued_ready: 0,
    queued_waiting: 0,
    inflight: 0,
    ambiguous: 0,
    delivered: 0,
    dead: 0,
    skipped: 0,
    discarded: 0,
    unsupported: 0,
  };
}

export function summarize(jobs, now = Date.now(), extra = {}) {
  const counts = emptyCounts();
  let oldestQueued = null;
  const held = [];
  for (const job of jobs) {
    const state = job.state;
    if (Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
    else counts.unsupported += 1;
    if (state === 'queued') {
      if (job.ready && (job.next_attempt_at || 0) <= now) counts.queued_ready += 1;
      else counts.queued_waiting += 1;
      if (oldestQueued == null || job.created_at < oldestQueued) oldestQueued = job.created_at;
    }
    if (state === 'ambiguous' || state === 'dead' || state === 'inflight') {
      if (held.length < 50) held.push(publicJob(job));
    }
  }
  return {
    updated_at: new Date(now).toISOString(),
    guarantee: 'at-least-once-for-explicit-rejection; ambiguous-held-unless-opt-in; not-exactly-once',
    retry_ambiguous: Boolean(extra.retryAmbiguous),
    counts,
    oldest_queued_at: oldestQueued,
    oldest_queued_age_ms: oldestQueued == null ? null : Math.max(0, now - oldestQueued),
    held,
  };
}

function jobPaths(dir) {
  return {
    dir,
    jobsDir: path.join(dir, 'jobs'),
    idDir: path.join(dir, 'by-message'),
    commandDir: path.join(dir, 'commands'),
    quarantineDir: path.join(dir, 'quarantine'),
    metaFile: path.join(dir, 'META.json'),
    statusFile: path.join(dir, 'status.json'),
  };
}

function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

export function readSnapshot(dir, now = Date.now()) {
  if (!fs.existsSync(dir)) {
    return { dir_present: false, counts: emptyCounts(), jobs: [], held: [], unreadable: 0, error: null };
  }
  const paths = jobPaths(dir);
  if (fs.existsSync(paths.metaFile)) {
    try {
      const meta = readJsonFile(paths.metaFile);
      if (meta?.v !== STORE_VERSION) {
        return {
          dir_present: true,
          counts: emptyCounts(),
          jobs: [],
          held: [],
          unreadable: 0,
          error: 'unsupported_store_version',
        };
      }
    } catch {
      return { dir_present: true, counts: emptyCounts(), jobs: [], held: [], unreadable: 0, error: 'bad_meta' };
    }
  }
  const jobs = [];
  let unreadable = 0;
  if (fs.existsSync(paths.jobsDir)) {
    for (const name of fs.readdirSync(paths.jobsDir)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try {
        const loaded = readJsonFile(path.join(paths.jobsDir, name));
        if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
          unreadable += 1;
          continue;
        }
        const job = loaded.v != null && loaded.v !== 1 ? { ...loaded, state: 'unsupported' } : loaded;
        jobs.push(job);
      } catch {
        unreadable += 1;
      }
    }
  }
  jobs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const summary = summarize(jobs, now);
  return {
    dir_present: true,
    error: null,
    unreadable,
    counts: summary.counts,
    held: summary.held,
    oldest_queued_age_ms: summary.oldest_queued_age_ms,
    guarantee: summary.guarantee,
    jobs: jobs.map(publicJob),
  };
}

export function openStore(dir, opts = {}) {
  const nowFn = opts.now || (() => Date.now());
  const paths = jobPaths(dir);
  fs.mkdirSync(paths.jobsDir, { recursive: true });
  fs.mkdirSync(paths.idDir, { recursive: true });
  fs.mkdirSync(paths.commandDir, { recursive: true });
  fs.mkdirSync(paths.quarantineDir, { recursive: true });

  let meta = { v: STORE_VERSION };
  if (fs.existsSync(paths.metaFile)) {
    try {
      meta = readJsonFile(paths.metaFile);
    } catch {
      throw new Error('delivery store META.json is unreadable');
    }
    if (meta?.v !== STORE_VERSION) {
      throw new Error(`delivery store version ${meta?.v} is unsupported`);
    }
  } else {
    atomicWrite(paths.metaFile, JSON.stringify({ v: STORE_VERSION }));
  }

  const memory = new Map();
  const byMessage = new Map();
  let nextSeq = 1;
  let closed = false;
  let unreadable = 0;

  function jobFile(id) {
    return path.join(paths.jobsDir, `${id}.json`);
  }
  function messageFile(messageId) {
    return path.join(paths.idDir, idFileName(messageId));
  }

  function persist(job) {
    atomicWrite(jobFile(job.id), JSON.stringify(job));
    memory.set(job.id, job);
  }

  function writeStatus() {
    try {
      const summary = summarize([...memory.values()], nowFn(), opts);
      atomicWrite(paths.statusFile, JSON.stringify(summary, null, 2));
    } catch (e) {
      opts.warn?.(`[delivery] status write failed: ${e?.message || e}`);
    }
  }

  function quarantine(file, reason) {
    try {
      const base = `${path.basename(file)}.${Date.now()}`;
      fs.mkdirSync(paths.quarantineDir, { recursive: true });
      fs.renameSync(file, path.join(paths.quarantineDir, base));
      opts.warn?.(`[delivery] quarantined unreadable job (${reason})`);
    } catch (e) {
      opts.warn?.(`[delivery] could not quarantine job: ${e?.message || e}`);
    }
  }

  if (fs.existsSync(paths.jobsDir)) {
    for (const name of fs.readdirSync(paths.jobsDir)) {
      if (!name.endsWith('.json')) {
        if (name.startsWith('.')) continue;
        continue;
      }
      const file = path.join(paths.jobsDir, name);
      let job;
      try {
        job = readJsonFile(file);
      } catch {
        unreadable += 1;
        quarantine(file, 'bad-json');
        continue;
      }
      if (!job || typeof job !== 'object' || !job.id || !job.message_id) {
        unreadable += 1;
        quarantine(file, 'missing-id');
        continue;
      }
      if (job.v != null && job.v !== 1) {
        const held = { ...job, state: 'unsupported' };
        memory.set(held.id, held);
        byMessage.set(String(held.message_id), held.id);
        if ((held.seq || 0) >= nextSeq) nextSeq = held.seq + 1;
        continue;
      }
      let changed = false;
      if (job.state === 'inflight') {
        job.state = 'ambiguous';
        job.last_outcome = job.last_outcome || 'crash_inflight';
        job.ux_pending = job.ux_pending || 'ambiguous';
        job.leased_at = null;
        job.updated_at = nowFn();
        changed = true;
      } else if (job.state === 'queued' && job.ready === false && job.kind !== 'skip') {
        job.ready = true;
        job.recovered_unready = true;
        job.updated_at = nowFn();
        changed = true;
      }
      if (changed) persist(job);
      else memory.set(job.id, job);
      byMessage.set(String(job.message_id), job.id);
      if ((job.seq || 0) >= nextSeq) nextSeq = job.seq + 1;
    }
  }

  for (const [messageId, jobId] of byMessage) {
    const file = messageFile(messageId);
    try {
      if (!fs.existsSync(file)) atomicWrite(file, jobId);
    } catch { /* index is rebuilt on the next open */ }
  }
  if (fs.existsSync(paths.idDir)) {
    for (const name of fs.readdirSync(paths.idDir)) {
      if (name.startsWith('.')) continue;
      const pointed = fs.readFileSync(path.join(paths.idDir, name), 'utf8').trim();
      if (!memory.has(pointed)) {
        try { fs.rmSync(path.join(paths.idDir, name), { force: true }); } catch { /* ignore */ }
      }
    }
  }
  writeStatus();

  function requireOpen() {
    if (closed) throw new Error('delivery store is closed');
  }

  function claimMessage(messageId, jobId) {
    const file = messageFile(messageId);
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600);
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
    try {
      fs.writeFileSync(fd, jobId);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  }

  function insert(fields) {
    requireOpen();
    const messageId = String(fields.message_id);
    const existingId = byMessage.get(messageId);
    if (existingId && memory.has(existingId)) {
      return { duplicate: true, job: clone(memory.get(existingId)) };
    }
    const seq = nextSeq++;
    const ts = nowFn();
    const job = {
      v: 1,
      id: `j_${seq}_${crypto.randomBytes(4).toString('hex')}`,
      message_id: messageId,
      chat_id: fields.chat_id ?? null,
      kind: fields.kind || 'delivery',
      state: fields.state || 'queued',
      ready: fields.ready !== false,
      seq,
      attempts: fields.attempts || 0,
      payload: fields.payload === undefined ? null : fields.payload,
      reason: fields.reason || null,
      created_at: ts,
      updated_at: ts,
      next_attempt_at: Object.prototype.hasOwnProperty.call(fields, 'next_attempt_at')
        ? fields.next_attempt_at
        : ts,
      leased_at: null,
      last_outcome: fields.last_outcome || null,
      last_error: fields.last_error || null,
      last_status: fields.last_status ?? null,
      delivered_at: fields.delivered_at ?? null,
      ux_pending: fields.ux_pending || null,
      ux_done: false,
    };
    if (!claimMessage(messageId, job.id)) {
      const idOnDisk = fs.readFileSync(messageFile(messageId), 'utf8').trim();
      const prev = memory.get(idOnDisk);
      return { duplicate: true, job: prev ? clone(prev) : null };
    }
    try {
      persist(job);
    } catch (e) {
      try { fs.rmSync(messageFile(messageId), { force: true }); } catch { /* ignore */ }
      throw e;
    }
    byMessage.set(messageId, job.id);
    writeStatus();
    return { duplicate: false, job: clone(job) };
  }

  return {
    dir,
    paths,
    unreadable: () => unreadable,
    has(messageId) {
      return byMessage.has(String(messageId));
    },
    get(id) {
      const job = memory.get(id);
      return job ? clone(job) : null;
    },
    getByMessageId(messageId) {
      const id = byMessage.get(String(messageId));
      return id ? clone(memory.get(id)) : null;
    },
    insertDelivery(fields) {
      return insert({ ...fields, kind: 'delivery' });
    },
    insertSkip(messageId, reason) {
      return insert({
        message_id: messageId,
        kind: 'skip',
        state: 'skipped',
        ready: true,
        reason,
        payload: null,
        next_attempt_at: null,
      });
    },
    update(id, patch) {
      requireOpen();
      const cur = memory.get(id);
      if (!cur) throw new Error(`unknown delivery job ${id}`);
      if (patch.message_id != null && String(patch.message_id) !== String(cur.message_id)) {
        throw new Error('message_id is immutable');
      }
      const next = { ...cur, ...patch, id: cur.id, message_id: cur.message_id, updated_at: nowFn() };
      persist(next);
      writeStatus();
      return clone(next);
    },
    list() {
      return [...memory.values()].map(clone).sort((a, b) => a.seq - b.seq);
    },
    summary() {
      return summarize([...memory.values()], nowFn(), opts);
    },
    listCommands() {
      requireOpen();
      if (!fs.existsSync(paths.commandDir)) return [];
      const out = [];
      for (const name of fs.readdirSync(paths.commandDir).sort()) {
        if (!name.endsWith('.json') || name.startsWith('.')) continue;
        const file = path.join(paths.commandDir, name);
        try {
          const cmd = readJsonFile(file);
          out.push({ file, cmd });
        } catch {
          quarantine(file, 'bad-command');
        }
      }
      return out;
    },
    removeCommand(file) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    },
    close() {
      closed = true;
      memory.clear();
      byMessage.clear();
    },
  };
}

export function writeCommand(dir, cmd) {
  const commandDir = path.join(dir, 'commands');
  fs.mkdirSync(commandDir, { recursive: true });
  const name = `c_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.json`;
  atomicWrite(path.join(commandDir, name), JSON.stringify(cmd));
  return name;
}

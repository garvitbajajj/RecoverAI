/**
 * AUDIT TRAIL  (Stage 4 support)
 * ------------------------------
 * Append-only decision log. Every diagnosis, decision, guardrail trip,
 * dispatch and retry outcome lands here as one JSON object per line.
 *
 * Why JSONL and not a database: the audit trail is evidence. A reviewer who
 * clones this repo can open data/audit_log.jsonl and read exactly what the
 * agent did and why, with no service to install and no connection to fail.
 * That serves "Build Quality: stable execution, full audit trail" better than
 * a store they cannot reach.
 *
 * The writer sits behind this interface deliberately -- swapping in Mongo
 * later means reimplementing `open/write/close`, and nothing upstream changes.
 *
 * This file must never read `_truth`.
 */

const fs = require('fs');
const path = require('path');

/** Stages an audit event can belong to. */
const STAGE = {
  DIAGNOSE: 'diagnose',
  DECIDE: 'decide',
  DISPATCH: 'dispatch',
  RETRY: 'retry',
  STOP: 'stop',
};

class JsonlAuditLog {
  constructor(file) {
    this.file = file;
    this.stream = null;
    this.count = 0;
  }

  open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // truncate: one file per run, so the log always matches the last run
    this.stream = fs.createWriteStream(this.file, { flags: 'w' });
    return this;
  }

  /**
   * @param {object} event  must carry at least { stage, transaction_id }
   */
  write(event) {
    if (!this.stream) throw new Error('audit log used before open()');
    this.stream.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
    this.count += 1;
  }

  close() {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      this.stream.end(resolve);
    });
  }
}

/** No-op sink, for tests or dry runs. Same interface. */
class NullAuditLog {
  constructor() {
    this.count = 0;
  }
  open() {
    return this;
  }
  write() {
    this.count += 1;
  }
  close() {
    return Promise.resolve();
  }
}

module.exports = { JsonlAuditLog, NullAuditLog, STAGE };

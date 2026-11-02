import { closeDb, config, getDb } from "@pulse-metric-studio/core";
import { emptyPulseDocument } from "@pulse-metric-studio/shared";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PulseRepository } from "./repository.js";

test("migration removes legacy drafts and preserves publication evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-preserve-"));
  config.dataDir = directory;
  config.dbPath = path.join(directory, "test.db");
  try {
    const db = getDb();
    db.exec(
      "DROP TABLE pulse_publish_items; DROP TABLE pulse_publish_runs; DROP TABLE pulse_workspaces; DELETE FROM _migrations WHERE key LIKE 'pulse:%'",
    );
    const document = {
      ...emptyPulseDocument(),
      version: 1,
      datasourceLuid: "ds",
      datasourceName: "Orders",
      digestAudience: "Sales leadership",
      chat: [{ role: "user", content: "Keep this work", ts: 123 }],
    };
    db.prepare("INSERT INTO pulse_drafts VALUES(?,?,?,?,?,?)").run(
      "connection",
      "https://tableau.test",
      "site",
      "ds",
      JSON.stringify(document),
      100,
    );
    db.prepare("INSERT INTO pulse_drafts VALUES(?,?,?,?,?,?)").run(
      "connection",
      "https://tableau.test",
      "site",
      "broken",
      "{invalid",
      100,
    );
    db.prepare("INSERT INTO drafts VALUES(?,?,?)").run(
      "unscoped",
      JSON.stringify(document),
      100,
    );
    db.prepare(
      "INSERT INTO runs(id,connection_id,datasource_luid,datasource_name,created_at,summary,group_id,group_name,server_url,site_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "old-run",
      "connection",
      "ds",
      "Orders",
      99,
      JSON.stringify({
        group: {
          id: "group",
          name: "Saved group",
          existedBefore: true,
          userAddFailed: true,
        },
        followResults: [
          { metricId: "metric", ok: false, error: "subscription denied" },
        ],
      }),
      "group",
      "Saved group",
      null,
      null,
    );
    db.prepare(
      "INSERT INTO run_metrics(run_id,item_index,definition_id,metric_id,name,payload_json,status,creation_status,resolution_status,undo_status,error,created_at,undo_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      "old-run",
      0,
      "definition",
      "metric",
      "Revenue",
      "{invalid",
      "created",
      "created",
      "resolved",
      "failed",
      "Original diagnostic",
      99,
      "Undo denied",
    );
    db.prepare(
      "INSERT INTO runs(id,connection_id,datasource_luid,datasource_name,created_at,summary) VALUES(?,?,?,?,?,?)",
    ).run(
      "malformed-run",
      "connection",
      "ds",
      "Orders",
      98,
      JSON.stringify({
        group: { id: 42 },
        followResults: [
          null,
          { metricId: {}, error: { secret: "do not copy" } },
        ],
      }),
    );
    db.prepare(
      "INSERT INTO run_metrics(run_id,item_index,definition_id,name,payload_json,status,creation_status,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      "malformed-run",
      0,
      "keep-confirmed",
      "Malformed context",
      JSON.stringify({
        specification: { basic_specification: { measure: { field: {} } } },
      }),
      "created",
      "created",
      98,
    );
    db.prepare("INSERT INTO pulse_drafts VALUES(?,?,?,?,?,?)").run(
      "connection",
      "not-a-url",
      "site",
      "bad-owner",
      JSON.stringify(document),
      100,
    );
    db.prepare(
      "UPDATE runs SET server_url='not-a-url', site_id='site' WHERE id='malformed-run'",
    ).run();
    closeDb();
    const repository = new PulseRepository();
    assert.equal(repository.listDrafts().total, 0);
    const receipt = repository.getReceipt("old-run");
    assert.equal(receipt.context, null);
    assert.equal(receipt.undoEligible, false);
    assert.equal(receipt.items[0]?.definitionId, "definition");
    assert.equal(receipt.items[0]?.diagnostic?.message, "Original diagnostic");
    assert.equal(receipt.items[0]?.undoDiagnostic?.message, "Undo denied");
    assert.equal(receipt.follow.group.status, "reused");
    assert.equal(receipt.follow.membership.status, "failed");
    assert.equal(receipt.follow.subscriptions[0]?.error, "subscription denied");
    assert.equal(
      (getDb().prepare("SELECT COUNT(*) AS count FROM drafts").get() as any)
        .count,
      0,
    );
    assert.equal(
      (
        getDb()
          .prepare("SELECT COUNT(*) AS count FROM pulse_drafts")
          .get() as any
      ).count,
      0,
    );
    const malformed = repository.getReceipt("malformed-run");
    assert.equal(malformed.items[0]?.definitionId, "keep-confirmed");
    assert.equal(malformed.follow.group.id, undefined);
    assert.equal(malformed.context, null);
    assert.equal(malformed.items[0]?.summary.fieldId, "");
    assert.equal(repository.listReceipts().receipts.length, 2);
    assert.equal(
      (
        getDb().prepare("SELECT payload_json FROM run_metrics").get() as {
          payload_json: string;
        }
      ).payload_json,
      "{invalid",
    );
    assert.ok(fs.existsSync(`${config.dbPath}.before-pulse-001.sqlite`));
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy draft cleanup preserves current long conversations, unrelated settings, and publication archives", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-cleanup-"));
  config.dataDir = directory;
  config.dbPath = path.join(directory, "test.db");
  try {
    const repository = new PulseRepository();
    const document = emptyPulseDocument();
    const transcript = "Transcript retained without truncation. ".repeat(15000);
    document.chat = [{ role: "user", content: transcript, ts: 1 }];
    const current = repository.createDraft({
      context: {
        connectionId: "keep",
        serverUrl: "https://tableau.test",
        siteId: "site",
        datasourceLuid: "ds",
      },
      datasourceName: "Current work",
      document,
    });
    const db = getDb();
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      "unrelated:setting:test",
      "Unrelated configuration",
    );
    db.prepare("INSERT INTO drafts VALUES(?,?,?)").run("legacy", "{}", 1);
    db.prepare("INSERT INTO pulse_drafts VALUES(?,?,?,?,?,?)").run(
      "old",
      "https://tableau.test",
      "site",
      "ds",
      "{}",
      1,
    );
    db.prepare(
      "INSERT INTO runs(id,connection_id,datasource_luid,datasource_name,created_at,summary) VALUES(?,?,?,?,?,?)",
    ).run("archive", "keep", "ds", "Evidence", 1, "{}");
    db.prepare("DELETE FROM _migrations WHERE key=?").run("pulse:002");
    closeDb();
    const reopened = new PulseRepository();
    assert.equal(
      reopened.getDraft(current.id).document.chat[0]?.content,
      transcript,
    );
    assert.equal(reopened.getDraft(current.id).revision, current.revision);
    assert.deepEqual(
      getDb()
        .prepare("SELECT value FROM settings WHERE key=?")
        .get("unrelated:setting:test"),
      { value: "Unrelated configuration" },
    );
    assert.ok(getDb().prepare("SELECT id FROM runs WHERE id=?").get("archive"));
    assert.equal(
      (
        getDb().prepare("SELECT count(*) AS count FROM drafts").get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        getDb().prepare("SELECT count(*) AS count FROM pulse_drafts").get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a database from a newer Pulse version is rejected before writes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-future-"));
  config.dataDir = directory;
  config.dbPath = path.join(directory, "test.db");
  try {
    getDb()
      .prepare("INSERT INTO _migrations VALUES(?,?)")
      .run("pulse:999", "future");
    closeDb();
    const original = fs.readFileSync(config.dbPath);
    assert.throws(() => getDb(), /unsupported pulse schema/);
    assert.deepEqual(fs.readFileSync(config.dbPath), original);
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

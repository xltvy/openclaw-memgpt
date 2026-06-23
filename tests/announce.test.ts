/**
 * Startup-banner dedupe (src/announce.ts). OpenClaw calls register() several
 * times per process; the banner must announce once per namespace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { takeFirstAnnounce, _resetAnnouncedNamespaces } from "../src/announce.ts";

test("takeFirstAnnounce: true once per namespace, then false", () => {
  _resetAnnouncedNamespaces();
  assert.equal(takeFirstAnnounce("ns"), true, "first call announces");
  assert.equal(takeFirstAnnounce("ns"), false, "second call (same ns) is deduped");
  assert.equal(takeFirstAnnounce("ns"), false, "third call too");
});

test("takeFirstAnnounce: a different namespace announces once of its own", () => {
  _resetAnnouncedNamespaces();
  assert.equal(takeFirstAnnounce("a"), true);
  assert.equal(takeFirstAnnounce("b"), true, "distinct namespace announces");
  assert.equal(takeFirstAnnounce("a"), false);
  assert.equal(takeFirstAnnounce("b"), false);
});

test("_resetAnnouncedNamespaces clears the guard", () => {
  _resetAnnouncedNamespaces();
  assert.equal(takeFirstAnnounce("x"), true);
  _resetAnnouncedNamespaces();
  assert.equal(takeFirstAnnounce("x"), true, "after reset, announces again");
});

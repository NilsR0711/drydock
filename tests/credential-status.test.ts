import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type DB } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import {
  CREDENTIAL_STATUS_KEY,
  type CredentialStatus,
  getCredentialFailures,
  getCredentialStatus,
  saveCredentialStatus,
} from "@/lib/orchestrator/credential-status";

let db: DB;

beforeEach(() => {
  db = createDb(":memory:");
});

describe("credential status store (issue #177)", () => {
  it("returns undefined before any probe has run", () => {
    expect(getCredentialStatus(db)).toBeUndefined();
  });

  it("round-trips a saved status", () => {
    const status: CredentialStatus = {
      checkedAt: 1_700_000_000,
      failures: [
        { target: "github", label: "GitHub CLI auth", message: "gh auth status exited 1" },
      ],
    };
    saveCredentialStatus(status, db);
    expect(getCredentialStatus(db)).toEqual(status);
  });

  it("overwrites the previous status on save", () => {
    saveCredentialStatus(
      {
        checkedAt: 1,
        failures: [{ target: "github", label: "GitHub CLI auth", message: "down" }],
      },
      db,
    );
    saveCredentialStatus({ checkedAt: 2, failures: [] }, db);
    expect(getCredentialStatus(db)).toEqual({ checkedAt: 2, failures: [] });
  });

  it("treats a corrupt persisted value as absent", () => {
    db.insert(settings).values({ key: CREDENTIAL_STATUS_KEY, value: "{not json" }).run();
    expect(getCredentialStatus(db)).toBeUndefined();
  });

  it("treats a schema-mismatched persisted value as absent", () => {
    db.insert(settings)
      .values({ key: CREDENTIAL_STATUS_KEY, value: JSON.stringify({ failures: "nope" }) })
      .run();
    expect(getCredentialStatus(db)).toBeUndefined();
  });
});

describe("getCredentialFailures", () => {
  it("returns an empty list before any probe has run", () => {
    expect(getCredentialFailures(db)).toEqual([]);
  });

  it("returns an empty list when the last probe found everything healthy", () => {
    saveCredentialStatus({ checkedAt: 10, failures: [] }, db);
    expect(getCredentialFailures(db)).toEqual([]);
  });

  it("returns the persisted failures after a failed probe", () => {
    const failures = [
      { target: "gitlab:https://gitlab.example.com", label: "GitLab", message: "HTTP 401" },
      { target: "agent:claude", label: "Claude CLI", message: "not found" },
    ];
    saveCredentialStatus({ checkedAt: 10, failures }, db);
    expect(getCredentialFailures(db)).toEqual(failures);
  });
});

# Microlink imitation implementation plan

> Execute the accepted conversation plan inline using executing-plans and TDD.

**Goal:** One Microlink capture, replay from local Node, and compare JSON.
**Architecture:** CLI with editable request profiles; native GET extraction plus headers Function; POST fetch inside a Function. Captures can be replayed without Microlink.
**Tech Stack:** Node 24, TypeScript, pnpm, native fetch/zlib, node:test.
**Implementation adjustment:** Direct API HTTP replaces the SDK because the public SDK transport cannot disable retries.
**Spec:** The user-approved plan in this conversation, including GET/POST examples.

## Global constraints
- Use the existing active Dev Container at /workspace; preserve .devcontainer.
- Do not store the pasted authorization token in the repository.
- No application retries, no automatic token bootstrap, no automatic provider traffic in tests.
- Distinguish observed/configured headers, service errors, upstream errors and content differences.
- A Function fetch does not prove the native managed proxy route works for POST.

## Task 1: Profiles and comparison
- [x] Write failing tests for JSON serialization, environment substitution, GET body validation and semantic JSON comparison.
- [x] Implement profile loading and response comparison.
- [x] Run tests and typecheck.

## Task 2: Capture and replay
- [x] Test the real HTTP boundary using a local Microlink test server and target server.
- [x] Implement native GET and Function POST capture, persisted snapshots, local replay, safe header forwarding, timeouts and failure classification.
- [x] Prove a capture uses one service request and replay uses none.
- [x] Verify missing key and malformed service replies stop replay.

## Task 3: CLI and docs
- [x] Test capture/replay/compare CLI with local servers and credential redaction.
- [x] Implement argument parsing, result files and readable summaries.
- [x] Document setup inside the Dev Container, profiles, commands and limitations.
- [x] Run tests, typecheck, build, Compose config and final review.

## Review focus
- Secrets must not be leaked into query parameters, snapshots or console summaries.
- Captured hop-by-hop or Microlink authentication headers must not reach the target.
- HTTP 200 from Microlink must not hide an upstream failure.
- JSON null and changing values must be compared correctly.
- Corrupt captures and timeouts must fail without retries or unsafe replay.

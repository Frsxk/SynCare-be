# Runtime-binding review and verification

This document describes the `scripts/runtime-bindings.ts` tooling: how an operator
builds a reviewed reference bundle, what the tooling proves, and what it
deliberately does not prove. It is not a production approval and does not contain
any real credentials, exports, pins, or engine identity.

## Trust model

A candidate must never be generated from the live engine alone. `inspect` requires
an externally reviewed reference bundle, and `verify` requires the same approved
reference again. The candidate manifest is self-reported tool output; verification
anchors the attested template values, code, graph data, folder and project to that
reference. Field-resolution metadata such as `load_from_db` is not attested; a
human must compare that metadata before production approval, since it can change
which runtime model/provider value is resolved. This tool is not a complete
semantic attestation of every Langflow field.

The tooling does not sign manifests and does not query the engine during `verify`.
A local verifier cannot prove that a hand-written manifest was produced by
`inspect`; it can prove that the manifest is internally consistent and descends
from the approved reference. Keep the reference bundle under human review control.

## Reference bundle layout

```
reviewed-bundle/
  runtime-binding-reference.json
  register_discharge_summary.json
  record_patient_checkin.json
  draft_followup_plan.json
  review_care_plan.json
  answer_care_questions.json
```

The five flow files are the reviewed exports. The JSON manifest is:

```json
{
  "schemaVersion": 1,
  "kind": "syncare-runtime-reference",
  "review": {
    "approved": true,
    "reviewer": "Named human reviewer",
    "reviewedAt": "2026-10-27T12:00:00.000Z",
    "note": "What was reviewed and why this bundle is the reference"
  },
  "target": {
    "folderId": "00000000-0000-4000-8000-000000000000",
    "projectId": "00000000-0000-4000-8000-000000000000",
    "canonicalReviewDbPath": "/absolute/path/to/syncare-review.sqlite3"
  },
  "flows": {
    "f1_register_discharge_summary": {
      "file": "register_discharge_summary.json",
      "sha256": "<sha256 of the exact file bytes>"
    },
    "f2_record_patient_checkin": {
      "file": "record_patient_checkin.json",
      "sha256": "<sha256 of the exact file bytes>",
      "roles": {
        "scorer": {
          "nodeType": "CustomComponent",
          "codeSha256": "<sha256 of the reviewed code string>",
          "requiredInputs": ["baseline_score", "patient_id"]
        }
      }
    },
    "f3_draft_followup_plan": {
      "file": "draft_followup_plan.json",
      "sha256": "<sha256 of the exact file bytes>"
    },
    "f4_review_care_plan": {
      "file": "review_care_plan.json",
      "sha256": "<sha256 of the exact file bytes>"
    },
    "f5_answer_care_questions": {
      "file": "answer_care_questions.json",
      "sha256": "<sha256 of the exact file bytes>",
      "roles": {
        "guard": {
          "nodeType": "CustomComponent",
          "codeSha256": "<sha256 of the reviewed code string>",
          "requiredInputs": ["input_value"]
        },
        "retriever": {
          "nodeType": "CustomComponent",
          "codeSha256": "<sha256 of the reviewed code string>",
          "requiredInputs": ["db_path", "input_value"]
        },
        "verifier": {
          "nodeType": "CustomComponent",
          "codeSha256": "<sha256 of the reviewed code string>",
          "requiredInputs": ["retrieved"]
        }
      }
    }
  }
}
```

`target.folderId` and `target.projectId`, when present, must be UUIDs.
`target.canonicalReviewDbPath` is optional but, when present, must match the
selected `--review-db` (or `SYNCARE_REVIEW_DB`) target physically.

## Required role inputs

The loader enforces the role sets exactly:

- F2: exactly `scorer`, with `baseline_score` and `patient_id` required.
- F5: exactly `guard`, `retriever`, `verifier`; the retriever must require
  `db_path`.
- No roles are accepted on F1, F3, or F4.

Role resolution compares `nodeType`, the SHA-256 of the exact `code.value`
string, and the input set. If `approvedInputs` is present, the node's input-key
set must match it exactly. Ambiguous matches and same-node role collisions are
refused.

## How an operator builds the reference

1. Export the five flows read-only from the actual approved Langflow engine.
   Keep the exported JSON byte-for-byte; do not reformat it after computing
   digests.
2. Redact secret material in template values before review. The loader scans
   every template value and code string for secret-shaped values and for values
   from the private environment. Environment values are collected from an
   explicit reviewed key list plus any key containing `SECRET` or ending in
   `API_KEY`, `TOKEN`, `PASSWORD` or `CREDENTIAL` (for example
   `AWS_SECRET_ACCESS_KEY`). A reference containing unreviewed secrets is
   refused. Redaction placeholders such as `***REDACTED***` and global-variable
   names are accepted.
3. Review the exact clinical code, model/provider choices, prompts, and edge
   data. The content digest described below covers every non-underscore template
   value (code is committed by its SHA-256) and every edge field.
4. Record each file's SHA-256 with `sha256sum` (Linux) or `Get-FileHash`
   (Windows). The manifest digest is over the bytes on disk.
5. Fill the role specs with the reviewed node type, exact code hash, required
   inputs, and optionally the approved input set.
6. Set the reviewed target folder, project (if the engine uses projects), and
   canonical review database path.
7. Set `review.approved: true` and name the reviewer and review time. This is a
   human decision; the tooling never creates or approves a reference itself.
8. Store the bundle outside the application repository and protect it as
   review evidence.

## Reviewed-content digest

For each flow the tooling derives an ID-normalized digest of reviewed content:

- Included: every non-underscore template value (the `code` value is replaced by
  its SHA-256), the node type, and every edge object including handle metadata
  and `data` fields such as `condition`.
- Per-node identity: each node's key is derived from its type, code hash and its
  canonical **normalized values**, so the digest binds values to a specific node
  rather than pooling them across nodes that merely share a structure. Nodes with
  different values never share a key, even when their type, code hash and input
  names are identical.
- Normalized: exact strings inside template values that equal a node ID become
  `<node:structural-key>` (a stable key derived from node type, code hash and
  input names, so regenerated IDs do not churn the digest); exact strings equal
  to a node ID at an edge endpoint or in handle metadata become
  `<node:value-key>` (the value-aware identity above); edge IDs become
  `<edge-id>`; exact flow IDs become `<flow:key>`; the target folder/project IDs
  become tokens; `_frontend_node_flow_id` and `_frontend_node_folder_id`
  metadata is excluded.
- Not normalized: model names, provider/backend choices, prompts, clinical text,
  numeric parameters, arbitrary template values, and arbitrary edge data.

The digest is computed from the reviewed reference at load time and recomputed
from the candidate's observed evidence during `verify`. It is also recorded in
the candidate manifest. A changed `model_name`, `vector_backend`, prompt, or edge
`condition` is refused even when the graph topology is otherwise unchanged, and a
value moved from one node to a same-structure sibling (for example swapping or
rotating the four F4 `SynCareReviewAction` gate actions) changes the digest and is
refused.

Regenerated Langflow node IDs are accepted only when the normalized reviewed
content and the structural topology still match. Structured edge handles and the
duplicate top-level `sourceHandle`/`targetHandle` JSON strings (including Langflow
œ-escaped strings) normalize exact ID fields consistently. Malformed serialized
handles are refused. Arbitrary clinical strings are not parsed or rewritten.
Changing a value that merely looks like an ID is not accepted.

Nodes identical in every attested value share a value-aware identity; their edge
incidence is pooled. This is not a general graph-isomorphism proof. Non-underscore
field values are attested, but field metadata (`load_from_db`, labels, visibility)
still requires a separate human comparison before production approval.

## Commands

```sh
bun scripts/runtime-bindings.ts inspect \
  --output /outside/repo/candidate \
  --reference /reviewed/runtime-reference-bundle \
  [--review-db /absolute/target/syncare-review.sqlite3]

bun scripts/runtime-bindings.ts verify \
  --candidate /outside/repo/candidate \
  --reference /reviewed/runtime-reference-bundle \
  [--review-db /absolute/target/syncare-review.sqlite3]
```

`--reference` may instead be supplied through `SYNCARE_RUNTIME_REFERENCE`.
Credentials come only from the private environment (`LANGFLOW_API_KEY`,
`GEMINI_API_KEY`, etc.); credential-shaped flags are refused and never echoed.

Flags are command-specific. For example, `inspect --candidate` and
`verify --output` are usage errors, not silently ignored options.

`inspect` performs GET requests only, stages exactly `flows.json`,
`config/f2-context.demo.json`, `config/f5-runtime.demo.json`, and
`runtime-bindings-manifest.json` into a new directory, and never writes active
configuration. The output directory is resolved physically: repo-internal
outputs (including `config/` and `flows/`, directly or through a symlink) are
refused.

`verify` reloads and validates the approved reference, then checks:

- the candidate's recorded reference manifest digest, export digests,
  reviewed-content digests, reviewer/time metadata, and role specs;
- the candidate target folder, project presence/value, and canonical database
  path against the reference and the selected target;
- each staged file digest and physical containment;
- graph topology, the consistency of the observed values with the reviewed edge
  tokens (recomputed from the raw observed edges), and the observed
  reviewed-content digest (recomputed from those values and edges);
- role type, code hash, and required inputs for every reviewed role;
- F2 scorer and F5 component pins, the F5 graph hash, and exactly three F5
  component pins.

A consistently retargeted folder, a removed project identity, a bogus reference
digest, and a candidate that recomputes its own content digest after changing a
reviewed value are all refused.

## Offline validator

`validateOfflineBundle` is a library-level check used by the focused tests. It
validates the shipped exports against `flows.json` and the demo configs, and
requires the F5 config to pin exactly the three reviewed components. It is not a
substitute for a reviewed reference: it has no approval metadata and no target
selection.

## Boundaries

- No `apply`/`import` command exists. Staging a candidate and applying it remain
  separate human actions.
- T12 remains BLOCKED until a real reviewed, redacted production export bundle is
  available. The synthetic test fixture is not production approval.
- T14 remains BLOCKED until the actual Windows Langflow engine and its private
  configuration can be attested. The tooling records no engine version, base URL,
  or engine identity; do not claim a verified engine version from a staged
  candidate.
- No `.env` file, live engine call, production pin, or export is created or
  modified by the focused test suite.

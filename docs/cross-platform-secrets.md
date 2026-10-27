# Private material on Windows and Linux

This backend keeps the Windows DPAPI envelope and adds a Linux AES-256-GCM
envelope behind the same `private-files` API. The adapter is fail-closed; demo
seeding and the protection CLI are OS-neutral and only differ in how the key is
supplied.

## Envelope contract

| Platform | On-disk prefix | Protection |
|---|---|---|
| Windows | `dpapi:v1:` | CurrentUser DPAPI, entropy `SynCare.local.private.v1` (unchanged) |
| Linux | `aesgcm:v1:` | AES-256-GCM; base64 of `IV(12)` + `tag(16)` + ciphertext; AAD `SynCare.local.private.v1:aesgcm:v1` |

Linux reads the key from the absolute path in `SYNCARE_PRIVATE_KEY_FILE`. The
file must be a regular, single-link, owner-owned file with exactly 32 raw bytes
and no group/other access (`0600`). The adapter never generates a key and never
falls back to plaintext. Windows does not read the key variable.

Legacy plaintext JSON remains readable as an explicit compatibility path. New
writes are always sealed. A `dpapi:` value is not decryptable on Linux: do not
copy Windows private files to Linux or pretend to migrate the DPAPI key;
re-provision the credentials there.

## Linux key provisioning (operator, one time)

Keep the key outside the repository and outside every demo root. The parent
directory is private and the key is owner-only:

```bash
install -d -m 700 "$HOME/.local/state/syncare"
head -c 32 /dev/urandom > "$HOME/.local/state/syncare/private.key"
chmod 600 "$HOME/.local/state/syncare/private.key"
export SYNCARE_PRIVATE_KEY_FILE="$HOME/.local/state/syncare/private.key"
```

Back the key up separately from the data. Losing it makes existing `aesgcm:v1:`
values unrecoverable; rotating it requires re-protecting every private file.
A systemd unit that reads protected values needs the same variable:

```ini
Environment=SYNCARE_PRIVATE_KEY_FILE=/home/<operator>/.local/state/syncare/private.key
```

On Windows no key setup is needed; DPAPI uses the current Windows account.

## Demo seeding

`seedDemo` now calls `writePrivateJson` on every OS. It no longer refuses to run
outside Windows.

```bash
bun scripts/demo-seed.ts init \
  --local-synthetic \
  --parent=/absolute/tmp/parent \
  --root=/absolute/tmp/parent/syncare-demo-<uuid-v4>

bun scripts/demo-seed.ts inspect --local-synthetic \
  --parent=/absolute/tmp/parent --root=/absolute/tmp/parent/syncare-demo-<uuid-v4>

bun scripts/demo-seed.ts reset --local-synthetic \
  --parent=/absolute/tmp/parent --root=/absolute/tmp/parent/syncare-demo-<uuid-v4> \
  --confirm=<rootId>
```

The root must be an absolute `syncare-demo-<uuid-v4>` directory directly under
an existing, real parent directory. The parent is canonicalized with `realpath`,
so a differently-cased or 8.3-spelled temporary directory addresses the same
place; a parent or root that is itself a symlink is still refused. On POSIX the
seed creates the root with mode
`0700`; the credential file is `0600`. Credentials and
`manifest.credentialHash` are written before the clinical fixture. `inspect` and
`reset` decrypt the credential file, so they require the key on Linux. `reset`
still requires the exact manifest `rootId` as `--confirm=<rootId>`, re-verifies
the clinical digest, and refuses unknown files, symlinks, hardlinks, or an
unmarked root. There is no automatic reset.

Roots created by the older seeder may be `0755`; `inspect`, `reset`, and the
protection CLI now reject them. If the root is genuinely owned demo output,
tighten it with `chmod 700 <root>` (and `chmod 600` the credential file) or
re-seed; never relax the check to accept shared output.

On Linux the key must exist before `init` and must be outside the demo root:

```bash
SYNCARE_PRIVATE_KEY_FILE=/home/<operator>/.local/state/syncare/private.key \
  bun scripts/demo-seed.ts init --local-synthetic --parent=/absolute/tmp --root=/absolute/tmp/syncare-demo-<uuid-v4>
```

On Windows the same command runs without `SYNCARE_PRIVATE_KEY_FILE` and writes a
native `dpapi:v1:` file.

## Protection CLI

The CLI takes only explicit, absolute input files. It no longer reads sibling
project directories or scans a workspace.

```bash
bun scripts/protect-local-secrets.ts --protect \
  --env-file /absolute/path/to/.env \
  --env-file /absolute/path/to/another.env \
  --json-file /absolute/path/to/credentials-private.json
```

`--env-file` and `--json-file` are repeatable. `--protect` is the explicit
operator authorization for converting plaintext in the named files;
`--operator-authorized` is accepted as an optional, recorded confirmation for
unattended scripts. There are no default paths.

Behaviour:

- Environment files: non-empty values whose final name word is `PASSWORD`,
  `PASSWD`, `PASS`, `PWD`, `SECRET`, `TOKEN`, or `KEY` are sealed, including
  camelCase names such as `myKey`. Other lines are preserved. A secret line is
  replaced as a whole value, keeping `export` and line endings.
- An environment secret must be assignable on one physical line: the key must
  match `[A-Za-z_][A-Za-z0-9_]*`, and a quoted value must close on the same line
  as its key. A quoted value that continues onto the next physical line is
  refused with `env_value_spans_lines` before anything is written, because a
  line-wise rewrite would leave the continuation behind as a live plaintext
  variable. Escape sequences such as `\n` inside a single-line value are data
  and do not trigger this refusal. Convert a genuinely multi-line value by hand.
  A secret-looking name outside the key grammar (`A.PASSWORD`, `A-TOKEN`) is
  refused with `unsupported_env_secret_name` rather than skipped under `PASS`.
- After rewriting, the whole file is parsed again and must keep the same key
  set, key order, non-secret values, and physical line count
  (`env_file_shape_changed` otherwise). A plan that would add, remove, or
  reinterpret any line is rejected before the write loop starts.
- JSON files: any field whose final name word is `password`, `passwd`, `pass`,
  `pwd`, `secret`, `token`, or `key` (including `cursorSecret` and `apiKey`)
  causes the whole document to be sealed, whatever the field's value type:
  `{"apiKey": 123}`, an array, or a nested object all seal the document. A file
  without such a field is left byte-identical.
- Already-sealed values (`dpapi:` or `aesgcm:`) are decrypted and validated,
  never encrypted again. On Linux a `dpapi:` value fails closed because the
  native key is unavailable; re-provision it.
- A file named `credentials-private.json` is treated as demo output only when a
  sibling `manifest.json` proves `version: 1`, `syntheticOnly: true`, a matching
  `rootId`, a supported stage, and a `credentialHash` equal to the SHA-256 of
  the current file. The hash is updated only after the sealed write verifies,
  and no other manifest field changes. A stale marker or hash refuses the
  conversion without writing. Without a manifest the file is protected as a
  standalone JSON document.
- Inputs must be regular, single-link files with a non-symlinked parent. On
  POSIX the file and its parent must be owned by the current UID and must not be
  group/world-writable (a world-writable sticky parent is allowed). On Windows
  those UID/mode checks are skipped: protection there is bounded by the file's
  NTFS ACL and the DPAPI account, not by POSIX bits. Relative paths, missing
  files, directories, symlinks, hardlinks, world-writable files, non-sticky
  world-writable parents, files over 2 MiB, and more than 64 inputs are
  rejected.
- Writes use a same-directory temporary file containing only protected content,
  `fsync`, atomic rename, and final mode `0600`. No plaintext backup or
  `.protected-tmp` file remains. Demo credential roots must be `0700`.
- The JSON result reports counts only: no key, token, password, or credential
  value is printed or passed on the command line.

### Migration from the historical command

The previous command hard-coded `SynCare-be/.env`, the dashboard
`.env.local`, and scanned `SynCare-be/data` plus `.tools/m11-demo-runs`. Those
assumptions are gone. Enumerate the files once and keep the command in the local
runbook.

Linux:

```bash
export SYNCARE_PRIVATE_KEY_FILE="$HOME/.local/state/syncare/private.key"
bun scripts/protect-local-secrets.ts --protect \
  --env-file /home/<operator>/kittys-workspace/syncare-be/.env \
  --env-file /home/<operator>/kittys-workspace/SynCare-nurse-dashboard/.env.local \
  --json-file /home/<operator>/owned-demo-runs/<run>/credentials-private.json
```

Windows PowerShell (no key variable):

```powershell
bun scripts/protect-local-secrets.ts --protect `
  --env-file C:\Users\<operator>\kittys-workspace\syncare-be\.env `
  --env-file C:\Users\<operator>\kittys-workspace\SynCare-nurse-dashboard\.env.local `
  --json-file C:\Users\<operator>\owned-demo-runs\<run>\credentials-private.json
```

Re-running the command is safe: sealed values are validated and the files stay
byte-identical. Do not point the CLI at unrelated clinical JSON/history; only
files named on the command line are touched.

## Verification

```bash
bun test test/demo-seed.test.ts test/protect-local-secrets.test.ts
bun test test/private-files.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The DPAPI parity test is Windows-only and is NOT RUN on Linux. Linux tests use
a fresh 32-byte key per test, outside the demo reset root, and pass it to child
processes explicitly. The shared seed/reset/sentinel cases and the
protection-CLI marker conversion are not skipped on Windows; POSIX mode-bit
assertions are guarded with `process.platform !== 'win32'` because Windows does
not enforce them.

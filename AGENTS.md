# purse

A pi extension that collects per-provider LLM billing state and serves it to other extensions and the user.

This repository follows the dx repo standard.

## Read first

| Document                                  | Holds, and when to read it                                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `docs/development.md`                     | Host APIs and extension loading — read before changing integration with pi.                                |
| pi-dent-agent `docs/pi-extension-repo.md` | Pi extension repository specifics — read before changing host release links, loading, or package metadata. |
| `.pi/pi-dent/terms.yaml`                  | Purse terminology; consult and change it through the Terms tool, not by editing the file.                  |

## Commands

```sh
pnpm check        # typecheck, lint, fmt:check, test
pnpm test
pnpm typecheck
pnpm lint
pnpm fmt          # rewrites files, Markdown included
pnpm fmt:check
```

## Rules

- purse owns its identifiers: package `pi-dent-purse`, `purse.conf`, `~/.pi/purse/`, `PURSE_*`, `purse:*` event channels. It reads no pi-dent configuration and depends on no other extension.
- Credentials, account identifiers, raw vendor responses, and URLs carrying keys never go into comments, fixtures, commit messages, replies, UI, or diagnostics. Fixtures are redacted by hand.
- Tests never touch the network or run `gcloud`; adapters receive external dependencies as inputs.

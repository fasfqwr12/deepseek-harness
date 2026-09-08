# Agent Note: Preserve platform optional dependencies in packed installs

Status: implemented

English | [中文](2026-08-23-packed-install-platform-optionals.zh.md)

## Problem

The packed-artifact verification installed its throwaway consumer with npm's global `--omit=optional` option. That treated every optional dependency as a dispensable feature, but several runtime dependencies use optional packages as the standard platform-selection mechanism. Koffi selects a prebuilt native payload such as `@koromix/koffi-win32-x64`; packaged ripgrep follows the same pattern. Omitting those packages makes a Windows consumer either attempt an unsupported source build or fail when it loads the missing platform executable.

The Landlock entry also declares platform packages as optional dependencies, but each package declares its supported `os` and `cpu`. npm already skips incompatible Linux packages on Windows and selects only the matching package on a supported Linux runner. A global omission therefore removed required Windows payloads without improving Landlock portability.

## Decision

`verify-packed-install` runs `npm install` without `--omit=optional`. npm resolves the real dependency graph and applies each optional package's `os` and `cpu` constraints. The verification does not add Koffi, ripgrep, or a Landlock platform package as a synthetic top-level dependency and does not install a native compiler toolchain to compensate for a missing prebuilt payload.

The install arguments and executable selection live in importable helpers so focused unit tests pin the complete command policy. Windows runs the npm JavaScript CLI with the current Node executable because hardened Node process spawning does not execute `npm.cmd` without a shell; other platforms invoke `npm` directly. The external-consumer verification remains the behavioral proof: it installs the packed set outside the workspace and drives the installed `dsh --version` entry with plain Node. Platform-specific release lanes remain responsible for exercising native runtime loads on their hosts.

## Alternatives considered

**Install CMake and a native compiler on the Windows verifier.** Rejected because the supported Koffi path is its prebuilt platform package. Building from source would hide an incomplete consumer dependency graph and add a toolchain that external users are not expected to have.

**Declare `@koromix/koffi-win32-x64` directly in the throwaway consumer.** Rejected because it hard-codes one operating system and architecture outside Koffi's manifest. It would bypass the dependency relationship being verified and require another branch for every platform.

**Omit only Landlock's optional packages.** Rejected because npm's omit option applies to the dependency class globally, not to one package subtree. The Landlock platform manifests already express the exact compatibility filter.

## Consequences

Packed installation now includes compatible optional runtime payloads and skips incompatible ones through npm's platform checks. On Windows, the Koffi prebuilt package can load without CMake; Linux-only Landlock packages remain absent. On a matching Linux runner, npm may install the corresponding Landlock binary package, which is the declared consumer behavior.

The Windows verifier requires npm to be bundled beside the active Node installation at `node_modules/npm/bin/npm-cli.js`, which is the layout provided by the supported Node installer and CI setup. A Node-only portable runtime without npm fails explicitly instead of falling back to a shell or another global shim.

The verification may fetch compatible optional packages owned by external dependencies in addition to their entry packages. This is intentional registry traffic and matches a real consumer installation. A package that incorrectly declares its platform metadata can now fail this verification instead of being hidden by blanket omission.

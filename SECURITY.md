# Security policy

## Supported versions

The project is pre-1.0. Security fixes target the latest release on `main`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**Security → Advisories → Report a vulnerability** at
<https://github.com/Quad-Plex/bevel-studio/security/advisories/new>.

Please do not open a public issue for a suspected vulnerability. Include the
affected version or commit, reproduction steps and the impact you expect.

You can expect an acknowledgement within a few days and a coordinated
disclosure once a fix is available.

## Scope

Bevel Studio processes untrusted STL files locally and makes no network
requests. The relevant attack surface is the STL parser and repair pipeline
(crafted geometry that causes excessive memory use, pathological run time or a
crash) and the desktop shell. A crash on a malicious file is worth reporting;
so is a packaged build that runs with an unexpectedly permissive policy.

# Third-party notices

Motion Studio depends on open-source software. Production JavaScript dependencies were audited with `pnpm licenses list --prod --json`; Rust dependencies were audited from `cargo metadata` and `Cargo.lock`.

## JavaScript runtime

| License | Packages |
| --- | --- |
| Apache-2.0 | `@dimforge/rapier2d-compat`, `echarts` |
| Apache-2.0 OR MIT | `@tauri-apps/api` |
| MIT | `@pixi/colord`, `@types/earcut`, `@types/react`, `@xmldom/xmldom`, `csstype`, `eventemitter3`, `gifenc`, `gifuct-js`, `ismobilejs`, `js-binary-schema-parser`, `parse-svg-path`, `pixi.js`, `react`, `react-dom`, `scheduler`, `zod`, `zustand` |
| BSD-3-Clause | `@webgpu/types`, `tiny-lru`, `zrender` |
| ISC | `earcut`, `lucide-react` |
| 0BSD | `tslib` |

## Desktop runtime

The Tauri/Rust dependency graph is locked by `src-tauri/Cargo.lock`. Most crates use Apache-2.0, MIT, BSD, ISC, Unicode-3.0 or Zlib-family terms. The complete package/version/license list can be reproduced with:

```powershell
cd src-tauri
cargo metadata --format-version 1
```

The resolved graph also contains the following MPL-2.0 packages. Motion Studio does not modify their source files:

| Package | Version | Source |
| --- | --- | --- |
| `cssparser` | 0.36.0 | <https://github.com/servo/rust-cssparser> |
| `cssparser-macros` | 0.6.1 | <https://github.com/servo/rust-cssparser> |
| `dtoa-short` | 0.3.5 | <https://github.com/upsuper/dtoa-short> |
| `option-ext` | 0.2.0 | <https://github.com/soc/option-ext> |
| `selectors` | 0.36.1 | <https://github.com/servo/stylo> |

`r-efi` 5.3.0 and 6.0.0 are offered under `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; this distribution relies on the permissive MIT/Apache-2.0 alternatives.

The authoritative license texts and copyright notices remain in each dependency's source distribution. Apache ECharts embeds separately licensed BSD-3-Clause portions of d3.js, as documented by the ECharts distribution.

This file is informational and does not replace the license terms of any dependency.

# Portal design sources

The landing page uses the actual defuss-shadcn marketing header, navigation menu, hero, button, and semantic theme styles. Its layout adapts the split, inspectable-example composition and before-paint light/dark preference from the defuss-vae project page. The DNP text and FIRE-row figure come from this experiment.

| Source | Revision | Local use |
| --- | --- | --- |
| [defuss-vae reference page](https://github.com/kyr0/defuss-vae/blob/dc0f6b5ea4973b2f3224a589d38c19386126e09d/docs/index.html) and [composition stylesheet](https://github.com/kyr0/defuss-vae/blob/dc0f6b5ea4973b2f3224a589d38c19386126e09d/docs/assets/site.css) | `dc0f6b5ea4973b2f3224a589d38c19386126e09d` | The portal adapts the header/hero structure and theme preference. [MIT license](./LICENSE-defuss-vae.txt) |
| [defuss-shadcn v0.9.7](https://github.com/kyr0/defuss-shadcn/tree/c2e16120ff04c2ea8af7dfc41f2c378f2f3cf997) | `c2e16120ff04c2ea8af7dfc41f2c378f2f3cf997` | The pinned framework CSS is included locally under its [MIT license](./LICENSE.txt). |

Both framework files are unmodified. Their SHA-384 digests match the integrity declarations in the reference page. The input CSS has no remote imports or remote font URLs.

| Asset | Git blob | SHA-384 (base64) |
| --- | --- | --- |
| `core.min.css` | `018fc4d80ff9f17a9b967e2a820183532b24cb89` | `XTkN5+CRRKO70LZ4OcV6O+kj6BY5lxdsRQ02oMz3kDCm9kd4B+16jbojkbgrbL0e` |
| `all.min.css` | `af822cb08357e781abc0ced94a882bdb2bf92092` | `KNQj/Dk66BgA6c4mbwGVJt0hPZbRc8WN1s34HBwecCHZnN3vp631ctFMQgIjDo2f` |

The FIRE-row plate uses the 1,024 channels of `icl_block.head.2.weight` row 2 in numeric order, 64 per line. The release's 256 direct edits comprise 110 increased codes and 146 decreased codes. [Machine-readable model comparison](../../data/weights-explorer.json)

| [defuss-shadcn data-grid stylesheet](https://cdn.jsdelivr.net/gh/kyr0/defuss-shadcn@v0.9.12/dist/components/data-grid/data-grid.css) | v0.9.12 | `data-grid.css`, unmodified: tree-grid rows, toggle indentation and sticky head for the arena's revision lineage tree. The tree is rendered by `src/app/revisions-panel.ts` without the library's JavaScript. MIT, see `LICENSE.txt`. |
| [defuss-shadcn shape utilities](https://cdn.jsdelivr.net/gh/kyr0/defuss-shadcn@v0.9.12/dist/theme/utils/shapes.css) | v0.9.12 | `shapes.css`, unmodified: the hero speech bubble (`shape-message`) and its halo (`aura aura-glow`). |


Header icons: GitHub and Hugging Face marks from [Simple Icons](https://simpleicons.org) 13.21.0, CC0 1.0, inlined as SVG paths in `index.html`.
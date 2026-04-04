# cloudflare-to-bind
This is a utility to clone Cloudflare DNS zones to bind9, with support for mapping records to different addresses.

The main purpose of this is to have a local override copy of a zone with different local addresses for resolution, while still having Cloudflare manage your external DNS

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

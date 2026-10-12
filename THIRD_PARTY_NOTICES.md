# Third-Party Notices

Yolo and its Tesla client (Drive-In) depend on the following third-party software. Their licenses are listed below.

## Runtime Dependencies

### Mediabunny

- **License**: MPL-2.0
- **Source**: https://github.com/Vanilagy/mediabunny
- **Usage**: Browser media demuxing and WebCodecs decoding for canvas playback

Mediabunny is bundled with the Tesla client. Modified MPL-covered files must remain available under MPL-2.0.

### uqr

- **License**: MIT
- **Source**: https://github.com/unjs/uqr
- **Usage**: Draws the pairing QR code on the Tesla client

### Noto Sans, Noto Sans SC, Noto Sans JP, and Noto Sans KR

- **License**: OFL-1.1
- **Source**: https://github.com/notofonts
- **Distribution**: https://fonts.google.com
- **Usage**: CDN-hosted fonts for Latin, Simplified Chinese, Japanese, and Korean subtitles

The player requests weight 500 through the Google Fonts CSS API. Browsers load the Unicode-ranged font files needed for the active subtitle text instead of relying on a system or Plex-provided font collection.

### yt-dlp

- **License**: Unlicense
- **Source**: https://github.com/yt-dlp/yt-dlp
- **Usage**: External CLI tool for resolving video URLs and extracting stream metadata

yt-dlp is invoked as a subprocess and is not bundled with this project. Users must install it separately.

### FFmpeg

- **License**: LGPL-2.1-or-later (default build), GPL-2.0-or-later (with `--enable-gpl`), or non-redistributable (with `--enable-nonfree`)
- **Source**: https://ffmpeg.org/
- **Usage**: External CLI tool used for split-stream HLS fallback transcoding

FFmpeg is invoked as a subprocess and is not bundled with this project. Users must install it separately. If you redistribute binaries that include FFmpeg, verify the license of your FFmpeg build matches your distribution terms. See https://ffmpeg.org/legal.html for details.

### Deno

- **License**: MIT
- **Source**: https://github.com/denoland/deno
- **Usage**: Required by yt-dlp for YouTube nsig challenge solving (since yt-dlp 2025.11.12)

Deno is an external runtime and is not bundled with this project.

## Node.js Dependencies

All Node.js dependencies are listed in `package.json` files across the monorepo workspaces. Run `npm ls` to view the full dependency tree. Key dependencies include:

| Package | License | Usage |
|---------|---------|-------|
| hono | MIT | HTTP routing in the control plane and the media node |
| @hono/node-server | MIT | The media node's HTTP server |
| @cloudflare/workers-oauth-provider | MIT | OAuth for agents |
| @modelcontextprotocol/server | MIT | MCP server |
| agents | MIT | MCP transport on Cloudflare Workers |
| @simplewebauthn/server | MIT | Passkey sign-in |
| zod | MIT | MCP tool input schemas |
| better-sqlite3 | MIT | D1 stand-in for tests; reading the old Drive-In database in the one-time export |
| mediabunny | MPL-2.0 | Media demuxing and WebCodecs decoding |
| vite | MIT | Tesla client build tool (dev dependency) |
| wrangler | MIT OR Apache-2.0 | Control plane build and local development (dev dependency) |

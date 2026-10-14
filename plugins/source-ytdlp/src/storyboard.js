// The storyboard images a site publishes, as yt-dlp lists them among its
// formats (format_note "storyboard": sprite sheets of thumbnails, each sheet
// one fragment), turned into the sheets of the plugin API's storyboard()
// (Agent Note 2026-10-13-video-frames). The largest tiles win; a site
// without storyboard formats gives null, and Yolo reads frames instead.

const isStoryboard = (format) => (format?.format_note === "storyboard" || format?.protocol === "mhtml")
  && Array.isArray(format.fragments) && format.fragments.length
  && Number(format.columns) > 0 && Number(format.rows) > 0 && Number(format.width) > 0 && Number(format.height) > 0;

function fragmentUrl(format, fragment) {
  try {
    return new URL(fragment.url ?? fragment.path, format.fragment_base_url || undefined).href;
  } catch {
    return null;
  }
}

export function storyboardFromInfo(info) {
  const formats = (Array.isArray(info?.formats) ? info.formats : []).filter(isStoryboard);
  if (!formats.length) return null;
  const format = formats.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const columns = Number(format.columns);
  const rows = Number(format.rows);
  const fps = Number(format.fps);
  const sheets = [];
  let start = 0;
  for (const fragment of format.fragments) {
    const duration = Number(fragment.duration);
    const url = fragmentUrl(format, fragment);
    if (!(duration > 0) || !url) break;
    sheets.push({
      url,
      headers: format.http_headers ?? undefined,
      start,
      duration,
      columns,
      rows,
      tileWidth: Number(format.width),
      tileHeight: Number(format.height),
      // Seconds between tiles; the last sheet may hold fewer tiles.
      interval: fps > 0 ? 1 / fps : duration / (columns * rows),
    });
    start += duration;
  }
  if (!sheets.length) return null;
  return { title: info.title || info.fulltitle || null, duration: Number(info.duration) > 0 ? Number(info.duration) : start, sheets };
}

// Separate audio and video MP4 files (DASH-style, as many sites serve them)
// become one fMP4 HLS stream: the sidx box lists each segment's byte range,
// and every segment is served as a byte range of the original file. Ported
// from the Drive-In server's dash-hls.js.

export function parseMp4Structure(buffer, totalSize = 0) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let initEnd = 0;
  let sidxOffset = -1;
  let position = 0;

  while (position <= buf.length - 8) {
    const size = buf.readUInt32BE(position);
    if (size < 8 || position + size > buf.length) break;
    const type = buf.toString("ascii", position + 4, position + 8);
    if (type === "moov") initEnd = position + size - 1;
    else if (type === "sidx") sidxOffset = position;
    else if (type === "mdat") break;
    position += size;
  }

  const segments = [];
  let timescale = 1000;
  if (sidxOffset >= 0 && sidxOffset + 32 <= buf.length) {
    const sidxSize = buf.readUInt32BE(sidxOffset);
    const version = buf[sidxOffset + 8];
    let offset = sidxOffset + 16;
    timescale = buf.readUInt32BE(offset);
    offset += 4;
    if (!timescale) return { initEnd, segments, totalSize, timescale: 1000 };

    let firstOffset = 0;
    if (version === 0) {
      if (offset + 8 > buf.length) return { initEnd, segments, totalSize, timescale };
      firstOffset = buf.readUInt32BE(offset + 4);
      offset += 8;
    } else if (version === 1) {
      if (offset + 16 > buf.length) return { initEnd, segments, totalSize, timescale };
      firstOffset = Number(buf.readBigUInt64BE(offset + 8));
      offset += 16;
    } else {
      return { initEnd, segments, totalSize, timescale };
    }
    if (offset + 4 > buf.length) return { initEnd, segments, totalSize, timescale };
    const referenceCount = buf.readUInt16BE(offset + 2);
    offset += 4;

    let segmentStart = sidxOffset + sidxSize + firstOffset;
    for (let index = 0; index < referenceCount && offset + 12 <= buf.length; index += 1) {
      const firstWord = buf.readUInt32BE(offset);
      if (firstWord >>> 31) break;
      const referencedSize = firstWord & 0x7fffffff;
      const durationTicks = buf.readUInt32BE(offset + 4);
      if (!referencedSize) break;
      segments.push({
        start: segmentStart,
        end: segmentStart + referencedSize - 1,
        duration: durationTicks / timescale,
        durationTicks,
      });
      segmentStart += referencedSize;
      offset += 12;
    }
  }
  return { initEnd, segments, totalSize, timescale };
}

function mediaPlaylist(segments, { initPath, segmentPath }) {
  const targetDuration = Math.max(1, Math.ceil(Math.max(...segments.map((segment) => segment.duration))));
  const body = segments.flatMap((segment, index) => [
    `#EXTINF:${segment.duration.toFixed(6)},`,
    segmentPath(index),
  ]).join("\n");
  return `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:${targetDuration}
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-MAP:URI="${initPath}"
${body}
#EXT-X-ENDLIST
`;
}

// `paths` names the pipeline routes: { playlist(track), init(track),
// segment(track, index) } with track "video" or "audio". Returns null when a
// file has no segment index, so the caller can fall back.
export function buildDashHls({ video, audio, videoInfo, audioInfo, paths }) {
  if (!videoInfo?.segments?.length || !audioInfo?.segments?.length) return null;
  const videoCodec = video.codec || "avc1.640028";
  const audioCodec = audio.codec || "mp4a.40.2";
  const bandwidth = Math.round(((video.kbps || 2000) + (audio.kbps || 128)) * 1000);
  const width = video.width || 1280;
  const height = video.height || 720;
  const fps = video.fps || 30;
  const master = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",DEFAULT=YES,AUTOSELECT=YES,URI="${paths.playlist("audio")}"
#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${width}x${height},FRAME-RATE=${fps},CODECS="${videoCodec},${audioCodec}",AUDIO="audio"
${paths.playlist("video")}
`;
  const track = (name, info) => mediaPlaylist(info.segments, {
    initPath: paths.init(name),
    segmentPath: (index) => paths.segment(name, index),
  });
  return { master, video: track("video", videoInfo), audio: track("audio", audioInfo) };
}

export function expectedRangeBytes(rangeHeader) {
  const match = String(rangeHeader || "").match(/^bytes=(\d+)-(\d+)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  return end - start + 1;
}

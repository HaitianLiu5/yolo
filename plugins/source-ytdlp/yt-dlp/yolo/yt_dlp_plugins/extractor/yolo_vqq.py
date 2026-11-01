# A yt-dlp extension that the yt-dlp source plugin loads with --plugin-dirs
# (Agent Note 2026-10-26-tencent-sports-replays). Tencent Video's play-info
# API answers with H.264 unless a request asks for HEVC, and yt-dlp always
# asks. With --extractor-args "vqqvideo:codec=h264", for a screen that
# decodes only H.264, the request does not ask.

from yt_dlp.extractor.tencent import VQQVideoIE


class _VQQVideoCodecIE(VQQVideoIE, plugin_name='yolo'):
    def _download_webpage(self, url_or_request, video_id, *args, query=None, **kwargs):
        if query and 'hevclv' in query and self._configuration_arg('codec', ie_key='VQQVideo') == ['h264']:
            query = {key: value for key, value in query.items() if key != 'hevclv'}
        return super()._download_webpage(url_or_request, video_id, *args, query=query, **kwargs)

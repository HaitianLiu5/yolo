# A yt-dlp extension that the yt-dlp source plugin loads with --plugin-dirs
# (Agent Note 2026-10-27-bilibili-through-the-egress-rule). Bilibili's play
# info names each file's main URL and its backup URLs, and yt-dlp keeps only
# the main one. Asked from mainland China, through the owner's egress rule
# for Bilibili's pages, the main URL is often on a mainland peer CDN
# (*.mcdn.bilivideo.cn, *.mountaintoys.cn) that never answers the node, while
# a backup is on Bilibili's upos CDN, whose mirrors serve the same signed path
# from anywhere. This override makes the first upos URL the main one; the
# plugin then ranks the upos mirrors.
import re

from yt_dlp.extractor.bilibili import BiliBiliBangumiIE, BiliBiliIE

_UPOS = re.compile(r'^https?://upos-[a-z0-9-]+\.(?:bilivideo\.com|akamaized\.net)/', re.IGNORECASE)


def _upos_first(value):
    if isinstance(value, list):
        for item in value:
            _upos_first(item)
    elif isinstance(value, dict):
        main = value.get('baseUrl') or value.get('base_url')
        if isinstance(main, str) and not _UPOS.match(main):
            backups = value.get('backupUrl') or value.get('backup_url') or []
            upos = next((url for url in backups if isinstance(url, str) and _UPOS.match(url)), None)
            if upos:
                for key in ('baseUrl', 'base_url'):
                    if key in value:
                        value[key] = upos
        for item in value.values():
            if isinstance(item, (dict, list)):
                _upos_first(item)


class _BiliBiliUposIE(BiliBiliIE, plugin_name='yolo'):
    def extract_formats(self, play_info):
        _upos_first(play_info)
        return super().extract_formats(play_info)


class _BiliBiliBangumiUposIE(BiliBiliBangumiIE, plugin_name='yolo'):
    def extract_formats(self, play_info):
        _upos_first(play_info)
        return super().extract_formats(play_info)

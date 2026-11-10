# A yt-dlp extension that the yt-dlp source plugin loads with --plugin-dirs
# (Agent Note 2026-10-27-bilibili-through-the-egress-rule). Bilibili's play
# info names each file's main URL and its backup URLs, and yt-dlp keeps only
# the main one. Asked from mainland China, through the owner's egress rule
# for Bilibili's pages, the main URL is often on a mainland peer CDN
# (*.mcdn.bilivideo.cn, *.mountaintoys.cn) that never answers the node, while
# a backup is on Bilibili's own CDN, whose upos mirrors and PoPs
# (cn-*.bilivideo.com) serve the same signed /upgcxcode/ path from anywhere.
# This override makes the first such backup the main URL; the plugin then
# ranks the mirrors. Names that hand requests to a peer (upos-sz-302ppio)
# and URLs signed for peers (os=mcdn) are not Bilibili's own CDN.
import re
from urllib.parse import parse_qs, urlsplit

from yt_dlp.extractor.bilibili import BiliBiliBangumiIE, BiliBiliIE

_OWN_HOST = re.compile(r'^(?:[a-z0-9-]+\.bilivideo\.com|upos-[a-z0-9-]+\.akamaized\.net)$', re.IGNORECASE)


def _own_cdn(url):
    if not isinstance(url, str):
        return False
    parts = urlsplit(url)
    host = (parts.hostname or '').lower()
    return (parts.scheme in ('http', 'https') and bool(_OWN_HOST.match(host))
            and '302' not in host.split('.')[0]
            and parts.path.startswith('/upgcxcode/')
            and 'mcdn' not in parse_qs(parts.query).get('os', []))


def _upos_first(value):
    if isinstance(value, list):
        for item in value:
            _upos_first(item)
    elif isinstance(value, dict):
        main = value.get('baseUrl') or value.get('base_url')
        if isinstance(main, str) and not _own_cdn(main):
            backups = value.get('backupUrl') or value.get('backup_url') or []
            own = next((url for url in backups if _own_cdn(url)), None)
            if own:
                for key in ('baseUrl', 'base_url'):
                    if key in value:
                        value[key] = own
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

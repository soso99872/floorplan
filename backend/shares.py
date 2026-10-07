"""分享連結:把一份 Scene 存在伺服器上,任何拿到連結的人都能看(唯讀)。

沒有帳號系統,所以「誰能改、誰能刪」靠建立時發給設計師的 token:伺服器只存 token 的雜湊,
設計師的瀏覽器保存 token 原文,用它更新同一個連結(客戶手上的網址不變)或停止分享。
每份分享是 DATA_DIR/shares/<id>.json 一個檔案;id 夠長、猜不到。
"""
import hashlib
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{10,40}$")


class ShareNotFound(Exception):
    pass


class ShareForbidden(Exception):
    pass


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class ShareStore:
    def __init__(self, root: Path):
        self.dir = Path(root) / "shares"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, share_id: str) -> Path:
        if not ID_PATTERN.match(share_id):  # 擋掉 ../ 之類的路徑
            raise ShareNotFound(share_id)
        return self.dir / f"{share_id}.json"

    def _write(self, path: Path, record: dict):
        # 先寫暫存檔再改名,寫到一半當機也不會留下壞掉的檔案
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
        os.replace(tmp, path)

    def _read(self, share_id: str) -> dict:
        path = self._path(share_id)
        if not path.is_file():
            raise ShareNotFound(share_id)
        return json.loads(path.read_text(encoding="utf-8"))

    def create(self, name: str, scene: dict) -> tuple:
        share_id = secrets.token_urlsafe(12)
        token = secrets.token_urlsafe(24)
        now = time.time()
        self._write(self._path(share_id), {
            "name": name, "scene": scene, "created": now, "updated": now, "token_hash": _hash(token),
        })
        return share_id, token

    def get(self, share_id: str) -> dict:
        r = self._read(share_id)
        return {"name": r["name"], "scene": r["scene"], "updated": r["updated"]}

    def _check(self, record: dict, token: str):
        if not token or not secrets.compare_digest(record["token_hash"], _hash(token)):
            raise ShareForbidden()

    def update(self, share_id: str, token: str, name: str, scene: dict):
        r = self._read(share_id)
        self._check(r, token)
        r.update(name=name, scene=scene, updated=time.time())
        self._write(self._path(share_id), r)

    def delete(self, share_id: str, token: str):
        r = self._read(share_id)
        self._check(r, token)
        self._path(share_id).unlink()

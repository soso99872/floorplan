"""Scene JSON:整個產品的核心資料格式。

辨識產生它、編輯器修改它、3D 和匯出都從它生成。單位一律 mm,座標是模型座標
(x 向右、y 向上,原點在原圖左下角),角度單位是度、逆時針為正。
前端的 TypeScript 型別(frontend/src/scene/types.ts)必須跟這份保持一致。
"""
from typing import List, Literal, Optional, Tuple

from pydantic import BaseModel, Field

SCENE_VERSION = 1

Point = Tuple[float, float]


class Wall(BaseModel):
    """一段直牆:中心線從 a 到 b,厚度往中心線兩側各一半。"""
    id: str
    a: Point
    b: Point
    thickness: float = Field(gt=0)
    height: float = Field(gt=0)


class Opening(BaseModel):
    """掛在某道牆上的門、窗或開放通道。

    offset 是開口中心離牆起點 a 的距離(沿牆量)。
    swing:門往牆的哪一側開;+1 = 從 a 往 b 看的左手邊,-1 = 右手邊。
    hinge:單開門的鉸鏈在靠 a 那端 (start) 還是靠 b 那端 (end)。"""
    id: str
    wall: str
    kind: Literal["door", "window", "passage"]
    offset: float
    width: float = Field(gt=0)
    sill: float = Field(ge=0)
    head: float = Field(gt=0)
    leaves: int = Field(ge=0, le=2)
    swing: Literal[1, -1] = 1
    hinge: Literal["start", "end"] = "start"
    exterior: bool = False


class Room(BaseModel):
    id: str
    name: str
    polygon: List[Point]
    area: float  # m²
    floor_color: str  # 原圖上的地板顏色 #rrggbb;之後換成材質 id


class Furniture(BaseModel):
    """家具:type 對應前端型錄;(x, y) 是外框中心,angle 是局部 +x 軸的方向。
    局部 +y 指向家具背面(床頭、椅背、櫃子靠牆那側)。width 沿局部 x,depth 沿局部 y。"""
    id: str
    type: str
    x: float
    y: float
    angle: float
    width: float = Field(gt=0)
    depth: float = Field(gt=0)
    color: str
    options: dict = Field(default_factory=dict)


class Background(BaseModel):
    """原始平面圖,在 3D 裡當地板貼圖、在編輯器裡當底圖。"""
    src: str  # data URL(之後上線改成檔案網址)
    width: float  # 圖片在模型裡的寬 mm
    height: float


class Meta(BaseModel):
    mm_per_px: float
    wall_height: float
    wall_thickness: float
    background: Optional[Background] = None


class Scene(BaseModel):
    version: int = SCENE_VERSION
    meta: Meta
    walls: List[Wall] = Field(default_factory=list)
    openings: List[Opening] = Field(default_factory=list)
    rooms: List[Room] = Field(default_factory=list)
    furniture: List[Furniture] = Field(default_factory=list)

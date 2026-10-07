"""合成資料的檢查:同一個種子畫出來一模一樣;實心牆的畫法下,標成牆的像素在圖上真的是深色。"""
import numpy as np
import pytest

from synth.plans import from_resplan, load_resplan
from synth.render import DOOR, WALL, WINDOW, render, sample_style


@pytest.fixture(scope="module")
def plans():
    data = load_resplan()
    return [from_resplan(data[i]) for i in (0, 5, 77, 1234)]


def test_deterministic(plans):
    a, la, _ = render(plans[0], seed=7)
    b, lb, _ = render(plans[0], seed=7)
    assert np.array_equal(a, b) and np.array_equal(la, lb)


def test_labels_align_with_solid_walls(plans):
    import random
    for i, plan in enumerate(plans):
        random.seed(i)
        st = sample_style(plan)
        st.update(wall="solid", ink=(0, 0, 0), floor="none", furniture="none", text=False, dims=False, grid=False,
                  extras=False, hand=False, scan=False, blur=False, jpeg=False, rotate=False, lowres=False,
                  patches=False, outside=False, thin_inner=(i % 2 == 0))
        img, lab, _ = render(plan, seed=i, style=st)
        gray = img.mean(axis=2)
        walls = lab == WALL
        assert walls.mean() > 0.01
        # 牆的像素(扣掉反鋸齒的邊)幾乎都是黑的;不是牆的地方大多是白的
        core = walls & (np.roll(walls, 1, 0) & np.roll(walls, -1, 0) & np.roll(walls, 1, 1) & np.roll(walls, -1, 1))
        assert (gray[core] < 60).mean() > 0.97
        assert (gray[lab == 0] > 200).mean() > 0.85
        assert (lab == DOOR).any() and (lab == WINDOW).any()

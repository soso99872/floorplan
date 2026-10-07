"""U-Net:編碼器用 ImageNet 預訓練的 ResNet18(CPU 也跑得動),輸出每個像素 4 類(背景 / 牆 / 門 / 窗)。
輸入邊長要是 32 的倍數。"""
import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision.models import ResNet18_Weights, resnet18

NUM_CLASSES = 4
CLASS_NAMES = ["背景", "牆", "門", "窗"]


def conv_bn(cin, cout):
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU(inplace=True))


class Up(nn.Module):
    def __init__(self, cin, cskip, cout):
        super().__init__()
        self.conv = nn.Sequential(conv_bn(cin + cskip, cout), conv_bn(cout, cout))

    def forward(self, x, skip=None):
        x = F.interpolate(x, scale_factor=2, mode="nearest")
        if skip is not None:
            x = torch.cat([x, skip], dim=1)
        return self.conv(x)


class UNet(nn.Module):
    def __init__(self, pretrained=True):
        super().__init__()
        r = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1 if pretrained else None)
        self.stem = nn.Sequential(r.conv1, r.bn1, r.relu)  # 1/2, 64
        self.pool = r.maxpool
        self.l1, self.l2, self.l3, self.l4 = r.layer1, r.layer2, r.layer3, r.layer4  # 1/4 64, 1/8 128, 1/16 256, 1/32 512
        self.u4 = Up(512, 256, 256)
        self.u3 = Up(256, 128, 128)
        self.u2 = Up(128, 64, 64)
        self.u1 = Up(64, 64, 32)
        self.u0 = Up(32, 0, 16)
        self.head = nn.Conv2d(16, NUM_CLASSES, 1)

    def forward(self, x):
        s0 = self.stem(x)
        s1 = self.l1(self.pool(s0))
        s2 = self.l2(s1)
        s3 = self.l3(s2)
        s4 = self.l4(s3)
        y = self.u4(s4, s3)
        y = self.u3(y, s2)
        y = self.u2(y, s1)
        y = self.u1(y, s0)
        y = self.u0(y)
        return self.head(y)


MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)

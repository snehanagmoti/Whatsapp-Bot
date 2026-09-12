import getpass
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

from PIL import Image, ImageDraw


token = getpass.getpass("Token: ")
request = urllib.request.Request(
    "https://whatsapp-screenshot-bot.onrender.com/setup/qr.svg",
    headers={"Authorization": f"Bearer {token}"},
)
with urllib.request.urlopen(request, timeout=30) as response:
    svg = response.read()

root = ET.fromstring(svg)
_, _, width, height = map(int, root.attrib["viewBox"].split())
path = next(element for element in root if element.tag.endswith("path"))
cells = [(int(x), int(y)) for x, y in re.findall(r"M(\d+) (\d+)h1v1h-1z", path.attrib["d"])]

scale = 12
image = Image.new("RGB", (width * scale, height * scale), "white")
draw = ImageDraw.Draw(image)
for x, y in cells:
    draw.rectangle((x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1), fill="black")
image.save(sys.argv[1], format="PNG", optimize=True)

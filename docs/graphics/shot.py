
import asyncio, sys
from playwright.async_api import async_playwright

async def main():
    src, out = sys.argv[1], sys.argv[2]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={"width":1080,"height":1920}, device_scale_factor=1)
        await pg.goto("file://" + src)
        await pg.wait_for_timeout(600)
        await pg.screenshot(path=out)
        await b.close()
    print("wrote", out)

asyncio.run(main())

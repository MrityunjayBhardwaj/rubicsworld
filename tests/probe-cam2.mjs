import { chromium } from 'playwright'

const URL = process.env.URL || 'http://localhost:5175/'
const browser = await chromium.launch()
const page = await (await browser.newContext({viewport:{width:1280,height:800}})).newPage()

await page.goto(URL)
await page.waitForTimeout(1500)

const info = await page.evaluate(() => {
  const c = window.__cam
  return {
    pos: [c.position.x, c.position.y, c.position.z],
    quat: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
  }
})
console.log('camera:', JSON.stringify(info))
await browser.close()

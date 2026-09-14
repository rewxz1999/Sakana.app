// 诊断：KazumiRules 规则仓库各镜像可达性（index.json + 单条规则）
const axios = require('axios')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BASES = [
  'https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/main',
  'https://raw.githubusercontent.com/Predidit/KazumiRules/main',
  'https://cdn.jsdelivr.net/gh/Predidit/KazumiRules@main',
  'https://fastly.jsdelivr.net/gh/Predidit/KazumiRules@main',
  'https://gcore.jsdelivr.net/gh/Predidit/KazumiRules@main',
  'https://ghproxy.net/https://raw.githubusercontent.com/Predidit/KazumiRules/main',
  'https://gh-proxy.com/https://raw.githubusercontent.com/Predidit/KazumiRules/main',
  'https://raw.githack.com/Predidit/KazumiRules/main',
  'https://gitcode.com/gh_mirrors/ka/KazumiRules/raw/main'
]

;(async () => {
  for (const base of BASES) {
    const url = `${base}/index.json`
    const t0 = Date.now()
    try {
      const res = await axios.get(url, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': UA } })
      const body = String(res.data)
      let info = ''
      try {
        const j = JSON.parse(body)
        info = Array.isArray(j) ? `✅ JSON 数组 ${j.length} 条，样本=${j.slice(0, 3).map((x) => x.name).join(',')}` : `⚠️ JSON 但不是数组: ${body.slice(0, 60)}`
      } catch {
        info = `❌ 非 JSON（${body.length}B）：${body.slice(0, 70).replace(/\s+/g, ' ')}`
      }
      console.log(`[${Date.now() - t0}ms] ${base}\n     ${info}`)
    } catch (err) {
      console.log(`[${Date.now() - t0}ms] ${base}\n     ❌ 请求失败: ${String(err.message).slice(0, 90)}`)
    }
  }
})()

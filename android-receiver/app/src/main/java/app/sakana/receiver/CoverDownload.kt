package app.sakana.receiver

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL

private const val TAG = "SakanaCover"

/** 单张图的**原始**体积上限，防止有人塞一个几十兆的图把内存顶爆（解码前就拦掉）。 */
private const val MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 连接/读取超时：封面是"快点给不出来就先给占位图，之后再说"，不值得让用户等太久。 */
private const val TIMEOUT_MS = 6000

/**
 * 封面图片的**下载与解码**（从 `CoverLoader` 拆出来，那里只剩三级缓存的调度）。
 *
 * 拆开的原因很实际：这里面全是"网络 + 位图"的细节（超时、体积上限、两遍解码、
 * 明文 http 的补救），和"先看内存再看磁盘"的缓存策略是两件事，
 * 混在一个文件里会让两边都读不完（也把那个文件顶到 300 行以上）。
 */
internal object CoverDownload {

    /**
     * 取一张图的位图（只下载+解码，不碰缓存）。
     *
     * 明文 http 失败时会自动把同一个路径换成 https 再试一次。为什么需要这一步：
     * 真机验证发现电脑端给的封面地址里有 9 条是**纯 http 的直连**（`http://lain.bgm.tv/...`），
     * 它们永远下不下来，那 9 张封面就一直停在占位图上。
     * 换 https 是这边能做的成本最低的补救；成功之后缓存是按**原地址**存的，
     * 所以只会补救一次，之后都走缓存。
     */
    fun fetch(url: String): Bitmap? {
        val direct = fetchOnce(url)
        if (direct != null) return direct
        if (!url.startsWith("http://")) return null
        val upgraded = "https://" + url.removePrefix("http://")
        Log.i(TAG, "封面明文 http 失败，改用 https 重试：$upgraded")
        return fetchOnce(upgraded)
    }

    private fun fetchOnce(url: String): Bitmap? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "SakanaReceiver/1.0")
            }
            val code = conn.responseCode
            if (code !in 200..299) {
                Log.i(TAG, "封面下载失败（HTTP $code）：$url")
                return null
            }
            val bytes = conn.inputStream.use { it.readBytes() }
            if (bytes.size > MAX_IMAGE_BYTES) {
                Log.i(TAG, "封面过大（${bytes.size} 字节），放弃：$url")
                return null
            }
            decode(bytes)
        } catch (t: Throwable) {
            // 用 INFO 而不是 DEBUG：真机（vivo）会把 DEBUG 日志丢掉，而"图为什么出不来"
            // 恰恰是真机上唯一能查的线索（IOException / 证书 / 超时 都从这里出来）
            Log.i(TAG, "封面下载失败（${t.javaClass.simpleName}: ${t.message}）：$url")
            null
        } finally {
            runCatching { conn?.disconnect() }
        }
    }

    /**
     * 两遍解码：先只量尺寸算出采样率，再真正解码 ——
     * 直接解一张 4000px 的图，光位图就要几十兆，低端机上必然 OOM。
     */
    fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = CoverKeys.sampleSizeFor(bounds.outWidth)
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }
}

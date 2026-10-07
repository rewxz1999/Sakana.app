package app.sakana.receiver

import java.security.MessageDigest
import java.util.Locale

/**
 * 封面缓存的**键**与缩放参数（纯逻辑，可在桌面上直接断言，不需要模拟器）。
 *
 * 为什么键要用 URL 的哈希，而不是 URL 本身：
 *  · URL 里有 `/` `?` `&` `:` 这些文件名非法字符，直接用就得转义，转义规则还各平台不一致；
 *  · 番剧封面的 URL 常常很长（带一长串签名/尺寸参数），容易顶到文件系统的名字长度上限（255 字节）；
 *  · 但**同一张图的两个不同 URL 必须算两个键** —— 签名参数不同通常意味着内容会变，
 *    所以哈希的输入是**完整的 URL**，一个字符都不裁。
 * 取 SHA-1 的**前 16 字节**转成 32 个 hex 字符：对"几百到几千张封面"这个量级，
 * 碰撞概率可以忽略，又比完整 40 字符短一点（文件名短，目录操作快一点）。
 *
 * 扩展名跟着**我们实际写盘的编码格式**走（见 [isPng]），不跟 URL 走：
 * 内容是 JPEG 却叫 `.png` 是自欺欺人，以后谁来做清理/迁移都会被这个假名字坑。
 */
internal object CoverKeys {

    /** 解码/落盘的目标宽度：网格格子只有一两百 dp，400px 够清晰，又省内存和磁盘。 */
    const val TARGET_WIDTH = 400

    /** 磁盘上统一用 JPEG 质量 85：肉眼已经看不出差别，体积大约只有原图的 1/10。 */
    const val JPEG_QUALITY = 85

    /** 缓存文件名 = 哈希 + 扩展名。同一 URL 任何时候都得到同一个名字。 */
    fun keyFor(url: String): String = hash16(url) + (if (isPng(url)) ".png" else ".jpg")

    /** SHA-1 的前 16 字节，hex 小写（32 个字符）。 */
    fun hash16(text: String): String {
        val digest = MessageDigest.getInstance("SHA-1").digest(text.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(32)
        for (i in 0 until 16) sb.append(String.format(Locale.US, "%02x", digest[i]))
        return sb.toString()
    }

    /**
     * URL 指向的是不是 PNG。
     * 只按 URL 的**路径**判断（丢掉 query/fragment，大小写不敏感）——
     * 有些图床是 `xxx.png?imageView2/1/w/400`，后面那串不影响格式。
     *
     * 为什么要区分：PNG 可能有透明通道，压成 JPEG 透明区域会变黑块。
     * 这类封面很少（绝大多数是 jpg/webp），所以只特判 PNG 这一种，其余一律 JPEG。
     */
    fun isPng(url: String): Boolean {
        val path = url.substringBefore('?').substringBefore('#').lowercase(Locale.US)
        return path.endsWith(".png")
    }

    /**
     * 解码时用的 `inSampleSize`：在"解码结果宽度不低于 [target]"的前提下取最大的采样率。
     *
     * 为什么是"不低于"而不是"最接近"：`inSampleSize` 只能是 2 的幂，取到刚好小于目标值时
     * 图会明显发糊，而封面是要铺满网格的，宁可贵一点也要清楚；反正还要再压一遍 JPEG。
     */
    fun sampleSizeFor(width: Int, target: Int = TARGET_WIDTH): Int {
        if (width <= 0 || target <= 0) return 1
        var sample = 1
        var current = width
        while (current / 2 >= target) {
            current /= 2
            sample *= 2
        }
        return sample
    }
}

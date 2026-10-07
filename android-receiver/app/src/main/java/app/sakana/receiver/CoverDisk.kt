package app.sakana.receiver

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import java.io.File

private const val TAG = "SakanaCoverDisk"

/** 图片缓存的真实占用情况（设置页要显示的就是这个，数字全部现算，不写死）。 */
internal data class CoverCacheStats(val fileCount: Int, val bytes: Long, val newestAtMs: Long) {
    val isEmpty: Boolean get() = fileCount == 0
}

/**
 * 封面在**磁盘**上的缓存，落在 `cacheDir/covers/`。
 *
 * 为什么是 `cacheDir` 而不是 `filesDir`：这是纯缓存 —— 丢了只是下次要重新下，
 * 不影响任何功能。放 `cacheDir` 的额外好处是系统在存储告急时**也会**帮我们清，
 * 等于多了一层兜底（我们自己再用 [CoverLru] 主动管一层，免得等到系统来清就已经太晚了）。
 *
 * 并发：读写由 [CoverLoader] 的下载线程（3 个）+ 预取线程（2 个）并发调用，
 * 所以每个方法都自己处理异常，绝不让 I/O 错误冒到调用方去打断一次列表刷新。
 * 文件级的竞态（一个线程在读、另一个在写同一个文件）不会出问题：
 * 读失败就当没缓存（还会顺手把坏文件删掉重下），写是"整个文件覆盖写"。
 */
internal object CoverDisk {

    private const val DIR_NAME = "covers"

    /** 旧版命名：完整 SHA-1（40 hex）+ `.img`。见 [migrateLegacyNames]。 */
    private val LEGACY_NAME = Regex("^[0-9a-f]{40}\\.img$")

    @Volatile
    private var dir: File? = null

    fun init(context: Context) {
        val base = File(context.applicationContext.cacheDir, DIR_NAME)
        dir = base
        migrateLegacyNames()
    }

    /**
     * 把**上一版**的缓存文件名改成新格式，避免升级后把用户已经下过的封面全部作废。
     *
     * 旧命名是 `sha1(url)` 的全部 20 字节（40 个 hex）+ `.img`；新命名是**前 16 字节**（32 个 hex）
     * + 实际编码格式的扩展名。旧版本一律写 JPEG，所以直接截断 + 改成 `.jpg` 就是同一个文件，
     * 内容完全不用重下 —— 实测真机上有 82 张（约 10MB）就是这么保下来的。
     *
     * 只有一处不完美：源图是 PNG 的封面，新版要找的是 `…png`，
     * 迁移后的 `…jpg` 对它不算命中，会重下一次。这类占比极小（绝大多数封面是 jpg/webp），
     * 为它多写一套"两个名字都试"的查找逻辑不值得 —— 那种隐藏回退以后更难查。
     *
     * 只在 [init] 时跑一次；改名是就地操作、不会丢数据，失败了也只是下次重下。
     */
    private fun migrateLegacyNames() {
        val base = dir ?: return
        if (!base.isDirectory) return
        val legacy = try {
            base.listFiles { file -> file.isFile && LEGACY_NAME.matches(file.name) }
        } catch (t: Throwable) {
            null
        } ?: return
        if (legacy.isEmpty()) return
        var renamed = 0
        for (file in legacy) {
            val target = File(base, file.name.substring(0, 32) + ".jpg")
            if (target.exists()) {
                // 新名字已经有了（同一次升级跑了两遍）：旧文件是多余的，直接删
                runCatching { file.delete() }
                continue
            }
            if (runCatching { file.renameTo(target) }.getOrDefault(false)) renamed++
        }
        if (renamed > 0) Log.i(TAG, "封面缓存迁移：$renamed 张旧命名文件已改名复用（不用重新下载）")
    }

    fun fileFor(url: String): File? {
        val base = dir ?: return null
        if (!base.exists() && !base.mkdirs()) return null
        return File(base, CoverKeys.keyFor(url))
    }

    /** 这个地址是不是已经在磁盘上了（预取靠它跳过"已有的一个都不许重复抓"）。 */
    fun has(url: String): Boolean {
        val file = fileFor(url) ?: return false
        return file.isFile && file.length() > 0L
    }

    /**
     * 读缓存字节。命中时把文件的"最后访问时间"推到当前 —— 这就是 LRU 的顺序依据，
     * 见 [CoverFileInfo] 的说明。
     */
    fun read(url: String): ByteArray? {
        val file = fileFor(url) ?: return null
        if (!file.isFile || file.length() == 0L) return null
        return try {
            val bytes = file.readBytes()
            file.setLastModified(System.currentTimeMillis())
            bytes
        } catch (t: Throwable) {
            Log.d(TAG, "读封面缓存失败 ${file.name}: ${t.message}")
            null
        }
    }

    /**
     * 把**已经缩过**的位图写成文件。
     * 存缩放后的结果而不是原始字节：省磁盘，下次解码也不用再缩一遍（`inSampleSize` 会变成 1）。
     */
    fun write(url: String, bitmap: Bitmap): Boolean {
        val file = fileFor(url) ?: return false
        val format = if (CoverKeys.isPng(url)) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG
        return try {
            file.outputStream().use { bitmap.compress(format, CoverKeys.JPEG_QUALITY, it) }
            // 刚写完的一定是"最新访问"的，显式推一下时间，免得被启动清理误伤
            file.setLastModified(System.currentTimeMillis())
            true
        } catch (t: Throwable) {
            Log.d(TAG, "写封面缓存失败 ${file.name}: ${t.message}")
            // 写坏的文件宁可删掉：留着一个半张图会让这个地址永远黑着
            runCatching { file.delete() }
            false
        }
    }

    /** 删掉某个地址的缓存（文件坏了、或者用户手动清理）。 */
    fun delete(url: String) {
        val file = fileFor(url) ?: return
        runCatching { file.delete() }
    }

    /** 真实占用：张数、字节数、以及**最新一张的写入时间**（设置页的"缓存于 …"）。 */
    fun stats(): CoverCacheStats {
        val files = listFiles()
        if (files.isEmpty()) return CoverCacheStats(0, 0L, 0L)
        var bytes = 0L
        var newest = 0L
        for (file in files) {
            bytes += file.length()
            if (file.lastModified() > newest) newest = file.lastModified()
        }
        return CoverCacheStats(files.size, bytes, newest)
    }

    /**
     * 按 LRU 清到上限以内。
     * **只在启动时调一次**（以及写盘时发现超过软上限才再调一次）——
     * 每次写盘都扫目录的话，几千个文件的 `stat` 会直接拖慢列表滚动。
     */
    fun trim(force: Boolean = false) {
        val files = listFiles()
        if (files.isEmpty()) return
        val infos = files.map { CoverFileInfo(it.name, it.length(), it.lastModified()) }
        val total = CoverLru.totalBytes(infos)
        if (!force && !CoverLru.needsTrim(total)) return
        val doomed = CoverLru.evictOrder(infos)
        if (doomed.isEmpty()) return
        var deleted = 0
        val base = dir
        for (name in doomed) {
            if (base != null && runCatching { File(base, name).delete() }.getOrDefault(false)) deleted++
        }
        Log.i(TAG, "封面缓存清理：删除 $deleted 张（原 ${total / 1024} KB，上限 ${CoverLru.MAX_DISK_BYTES / 1024 / 1024} MB）")
    }

    /**
     * 清空图片缓存，返回删掉的张数。
     * **只删 `covers/` 目录**：收藏/历史存在 SharedPreferences 里（见 `SyncStore`），
     * 这里碰不到它们 —— 用户在设置页点"清理图片缓存"时不该丢收藏。
     */
    fun clear(): Int {
        val files = listFiles()
        var deleted = 0
        for (file in files) {
            if (runCatching { file.delete() }.getOrDefault(false)) deleted++
        }
        return deleted
    }

    private fun listFiles(): List<File> {
        val base = dir ?: return emptyList()
        if (!base.isDirectory) return emptyList()
        return try {
            base.listFiles()?.filter { it.isFile } ?: emptyList()
        } catch (t: Throwable) {
            Log.d(TAG, "列封面目录失败: ${t.message}")
            emptyList()
        }
    }
}

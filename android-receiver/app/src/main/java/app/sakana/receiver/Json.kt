package app.sakana.receiver

/**
 * 极小的 JSON 解析 / 序列化工具，**不引任何第三方库**。
 *
 * 为什么手写：本工程的 JSON 只有 4 个固定端点、字段全是简单类型。引 Gson / Moshi /
 * kotlinx-serialization 会让 APK 多出几百 KB；而且它们要么用反射、要么要注解处理器，
 * 都会给混淆和构建时间添麻烦。
 *
 * 解析器本体在 [JsonParser]（单独一个文件，见那里的说明）；
 * 本文件只负责"对外 API + 序列化 + 字段取值辅助函数"。
 *
 * 中间表示（直接用 Kotlin/Java 原生类型，不额外定义模型类）：
 *   对象   -> LinkedHashMap<String, Any?>（保持字段顺序，序列化结果稳定、方便人肉看）
 *   数组   -> ArrayList<Any?>
 *   字符串 -> String；布尔 -> Boolean；null -> null
 *   数字   -> 优先 Long；出现小数点/指数时退化为 Double
 *
 * ⚠️ 局限（够本协议用，**不要**拿它去解析任意 JSON）：
 *  1. 一次性解析整段文本，不做流式；内存占用约等于文本长度（本协议 body 只有几 KB）。
 *  2. 数字精度：整数走 Long，超出 Long 范围或带小数/指数会变 Double，可能丢精度。
 *     本协议里只有毫秒时间戳和下标，都远在 Long 安全范围内。
 *  3. 重复键：后者覆盖前者，不报错（故意宽松，容忍电脑端的粗糙实现）。
 *  4. 不支持注释、尾随逗号、单引号字符串、NaN/Infinity —— 它们本来就不是合法 JSON。
 *  5. 嵌套深度上限见 JsonParser.MAX_DEPTH。
 *  6. 不校验 schema：字段缺失/类型不符，由调用方通过 str/long/bool 的默认值兜住。
 *  7. 解析失败统一返回 null。本协议里合法文档必然是对象，所以 null 就等于"解析失败"。
 *  8. 解析成功后**忽略**尾随的多余内容（同样是故意宽松）。
 */
object Json {

    // ---------------- 解析 ----------------

    /** 解析 JSON 文本；失败返回 null（见类注释第 7 条）。 */
    fun parse(text: String): Any? = try {
        JsonParser(text).parseDocument()
    } catch (t: Throwable) {
        // 解析库自己抛的异常对调用方没意义：调用方只关心"能不能用"，
        // 所以这里统一吞掉并返回 null，避免每个调用点都写 try/catch。
        null
    }

    /** 把解析结果当对象用；不是对象（含解析失败）返回 null。 */
    @Suppress("UNCHECKED_CAST")
    fun obj(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

    /** 把解析结果当数组用；不是数组返回空表，这样调用方不用到处判空。 */
    @Suppress("UNCHECKED_CAST")
    fun arr(value: Any?): List<Any?> = value as? List<Any?> ?: emptyList()

    fun str(m: Map<String, Any?>, key: String): String? = m[key] as? String

    /**
     * 取一个整数。故意做得宽松：字符串形式的数字、布尔值都能认，
     * 因为电脑端的实现未必严格（例如把 value 写成 "12345"）。
     */
    fun long(m: Map<String, Any?>, key: String, def: Long = 0L): Long = when (val v = m[key]) {
        is Long -> v
        is Int -> v.toLong()
        is Double -> v.toLong()
        is Boolean -> if (v) 1L else 0L
        is String -> v.trim().toLongOrNull() ?: def
        else -> def
    }

    fun int(m: Map<String, Any?>, key: String, def: Int = 0): Int = long(m, key, def.toLong()).toInt()

    fun bool(m: Map<String, Any?>, key: String, def: Boolean = false): Boolean = when (val v = m[key]) {
        is Boolean -> v
        is Long -> v != 0L
        is Double -> v != 0.0
        is String -> v == "1" || v.equals("true", ignoreCase = true)
        else -> def
    }

    /**
     * 取出「字符串 -> 字符串」映射，专供 /play 的 headers 用。
     *  · 值不是字符串时用 toString() 兜底（电脑端可能把某个 id 写成了数字）；
     *  · 值为 null 的键直接丢掉 —— 空请求头没有意义，还可能让 HttpURLConnection 报错。
     */
    fun strMap(value: Any?): Map<String, String> {
        val m = obj(value) ?: return emptyMap()
        val out = LinkedHashMap<String, String>()
        for ((k, v) in m) {
            if (v == null) continue
            out[k] = if (v is String) v else v.toString()
        }
        return out
    }

    // ---------------- 序列化 ----------------

    fun stringify(value: Any?): String = StringBuilder(128).also { write(it, value) }.toString()

    private fun write(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> writeString(sb, v)
            is Boolean -> sb.append(if (v) "true" else "false")
            // Double.toString() 可能是 "1.0E10" 这种形式，但它仍是合法 JSON
            is Double -> sb.append(if (v.isFinite()) v.toString() else "0")
            is Float -> sb.append(if (v.isFinite()) v.toString() else "0")
            // 剩下的数字（Int/Long/Short/Byte）统一按十进制原样输出。
            // 放在 Double/Float 之后，所以不会被这两类抢走。
            is Number -> sb.append(v.toString())
            is Map<*, *> -> writeObject(sb, v)
            is Iterable<*> -> writeArray(sb, v)
            is Array<*> -> writeArray(sb, v.asList())
            // 其它类型（例如不小心塞进来的枚举）退化成字符串，
            // 保证一定生成合法 JSON，而不是崩在序列化上
            else -> writeString(sb, v.toString())
        }
    }

    private fun writeObject(sb: StringBuilder, m: Map<*, *>) {
        sb.append('{')
        var first = true
        for ((k, v) in m) {
            if (!first) sb.append(',')
            first = false
            writeString(sb, k?.toString() ?: "null")
            sb.append(':')
            write(sb, v)
        }
        sb.append('}')
    }

    private fun writeArray(sb: StringBuilder, list: Iterable<*>) {
        sb.append('[')
        var first = true
        for (v in list) {
            if (!first) sb.append(',')
            first = false
            write(sb, v)
        }
        sb.append(']')
    }

    private fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) {
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                // 其它控制字符必须转义，否则生成的不是合法 JSON
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                // 中文等非 ASCII 字符原样输出：响应整体按 UTF-8 编码，
                // JSON 允许直接出现 UTF-8 字符，转义反而让"titles"变得不可读
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }
}

package app.sakana.receiver

/**
 * JSON 的递归下降解析器。
 *
 * 单独放一个文件（而不是塞在 Json.kt 里），是为了让"对外 API / 序列化"和"解析细节"
 * 各自成为一个 300 行以内的、能一口气读完的单元。用法只有一处：`Json.parse`。
 *
 * 解析失败一律抛 IllegalArgumentException，由 [Json.parse] 统一转成 null ——
 * 调用方只关心"能不能用"，不关心失败在第几个字符。
 */
internal class JsonParser(private val src: String) {

    /** 记录当前解析到的位置，用于出错时给出可定位的提示。 */
    private var pos = 0

    fun parseDocument(): Any? {
        skipWhitespace()
        if (pos >= src.length) return null
        val value = parseValue(0)
        // 尾随内容不检查：宽松优先（见 Json 类注释第 8 条）
        return value
    }

    private fun parseValue(depth: Int): Any? {
        // 深度上限：防止畸形/恶意 JSON（比如几万个 '['）把解析递归栈撑爆
        if (depth > MAX_DEPTH) fail("嵌套过深")
        skipWhitespace()
        if (pos >= src.length) fail("内容意外结束")
        return when (val c = src[pos]) {
            '{' -> parseObject(depth)
            '[' -> parseArray(depth)
            '"' -> parseString()
            't' -> { expect("true"); true }
            'f' -> { expect("false"); false }
            'n' -> { expect("null"); null }
            else -> if (c == '-' || c in '0'..'9') parseNumber() else fail("出现了非法字符 '$c'")
        }
    }

    private fun parseObject(depth: Int): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        pos++ // 吃掉 '{'
        skipWhitespace()
        if (peek() == '}') {
            pos++
            return out
        }
        while (true) {
            skipWhitespace()
            if (peek() != '"') fail("对象的键必须是字符串")
            val key = parseString()
            skipWhitespace()
            if (peek() != ':') fail("键后面缺少 ':'")
            pos++
            out[key] = parseValue(depth + 1)
            skipWhitespace()
            when (peek()) {
                ',' -> pos++
                '}' -> { pos++; return out }
                else -> fail("对象里缺 ',' 或 '}'")
            }
        }
    }

    private fun parseArray(depth: Int): List<Any?> {
        val out = ArrayList<Any?>()
        pos++ // 吃掉 '['
        skipWhitespace()
        if (peek() == ']') {
            pos++
            return out
        }
        while (true) {
            out.add(parseValue(depth + 1))
            skipWhitespace()
            when (peek()) {
                ',' -> pos++
                ']' -> { pos++; return out }
                else -> fail("数组里缺 ',' 或 ']'")
            }
        }
    }

    private fun parseString(): String {
        pos++ // 吃掉开头的引号
        val sb = StringBuilder()
        while (true) {
            if (pos >= src.length) fail("字符串没有结束引号")
            val c = src[pos++]
            when {
                c == '"' -> return sb.toString()
                c == '\\' -> {
                    if (pos >= src.length) fail("转义符后面没有内容")
                    when (val e = src[pos++]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            if (pos + 4 > src.length) fail("\\u 后面不足 4 位")
                            val hex = src.substring(pos, pos + 4)
                            pos += 4
                            // 代理对（\uD83D\uDE00 这种）不用特殊处理：
                            // Kotlin 的 String 就是 UTF-16，两块分别 append 进去自然拼成一个字符
                            sb.append((hex.toIntOrNull(16) ?: fail("\\u 后面不是十六进制")).toChar())
                        }
                        else -> fail("不支持的转义 '\\$e'")
                    }
                }
                else -> sb.append(c)
            }
        }
    }

    private fun parseNumber(): Any {
        val start = pos
        if (peek() == '-') pos++
        // 宽松扫描：只要看起来像数字的一部分就继续吃（错误格式交给下面的转换去发现）
        while (pos < src.length) {
            val c = src[pos]
            if (c in '0'..'9' || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') pos++ else break
        }
        val token = src.substring(start, pos)
        if (token.isEmpty() || token == "-") fail("非法数字 '$token'")
        return if (token.indexOfFirst { it == '.' || it == 'e' || it == 'E' } >= 0) {
            token.toDoubleOrNull() ?: fail("非法数字 '$token'")
        } else {
            // 整数优先 Long；超出 Long 范围才退化成 Double（见 Json 类注释第 2 条）
            token.toLongOrNull() ?: token.toDoubleOrNull() ?: fail("非法数字 '$token'")
        }
    }

    private fun peek(): Char = if (pos < src.length) src[pos] else '\u0000'

    private fun skipWhitespace() {
        while (pos < src.length) {
            val c = src[pos]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++ else break
        }
    }

    private fun expect(literal: String) {
        if (!src.startsWith(literal, pos)) fail("期望字面量 '$literal'")
        pos += literal.length
    }

    private fun fail(message: String): Nothing =
        throw IllegalArgumentException("JSON 解析失败（位置 $pos）：$message")

    companion object {
        /** 递归深度上限。协议里的文档最多三四层，64 层足够宽松又不会爆栈。 */
        const val MAX_DEPTH = 64
    }
}

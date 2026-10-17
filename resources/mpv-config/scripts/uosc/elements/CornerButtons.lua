local Element = require('elements/Element')
local ManagedButton = require('elements/ManagedButton')

--[[
角标按钮容器（v1.1.5「退出 / 详情 / 截图 / 播放流详情 放到画面顶部两角」）

只做一件事：把一批**受管按钮**固定摆在左上角与右上角，不参与底部栏那套伸缩布局。

为什么不塞进 top_bar（顶栏）：
  uosc 5.13 的顶栏（elements/TopBar.lua）只有「标题 + 三个窗口按钮」，根本没有“按钮列表”这种选项；
  而且它一启用就会画「最小化 / 最大化 / 关闭」，其中关闭键直接执行 `quit`，会把嵌在 Electron
  窗口里的播放内核销毁 —— 这正是 uosc.conf.base 里把 top_bar 关掉的原因。角标按钮只能自己做一个 Element。

为什么不改 Controls（底部栏）：
  Controls 的布局是给“一条横向栏”用的，478 行里大半是 static/dynamic/space/gap 的伸缩与让位逻辑；
  角标只需要“固定尺寸、靠左/靠右排两小排”。复制那套会牵动已经验证过的底部栏，风险远大于收益。

为什么复用 ManagedButton：
  这几个按钮的图标 / 提示 / 激活态 / 可点性 / 点击行为全部由
  resources/mpv-scripts/sakana-uosc-ctrl.lua 用 `script-message-to uosc set-button <名字> <json>` 动态下发
  （见 elements/ManagedButton.lua）。角标里用**同一批按钮名**，于是角标里的“退出”和底部栏的“退出”
  天然是同一个行为，不需要在 Lua 里再写一遍 script-message / 动作映射。

主题色：
  绘制完全复用 Button.lua：前景 / 背景默认取 uosc 的全局 `fg` / `bg`，提示与角标由 ass/Button 用同一套
  主题色画。这些值由主进程按应用主题生成到 uosc.conf 的 `color=` 行（见 uosc.conf.base 头部说明），
  所以这里不写死任何颜色。

可见性：
  跟随 uosc 既有的 proximity 机制：容器矩形覆盖画面顶部那一条，鼠标靠近顶部时 `proximity` 由 0 涨到 1，
  子按钮通过 `anchor_id = 'corner_buttons'` 继承这份可见度（elements/Element.lua 的 get_visibility）。
  不另造计时器，也不改 Element/Elements 的命中判定。

  另外只在“有媒体在播”（state.path 非空且不在 idle）时启用：纯音频播放时退出 / 详情同样要能点，
  所以门槛不能写成 state.is_video。
]]

---@class CornerButtons : Element
local CornerButtons = class(Element)

-- 支持的两个角。写成其它名字（例如 bottom-left）会被忽略并打一条 warn，
-- 但不会影响其它按钮 —— 一个排版选项写错不该让整条控制栏消失。
local CORNERS = {'top-left', 'top-right'}

function CornerButtons:new() return Class.new(self) --[[@as CornerButtons]] end

function CornerButtons:init()
	Element.init(self, 'corner_buttons', {render_order = 6})
	---@type table<string, ManagedButton[]>
	self.buttons = {['top-left'] = {}, ['top-right'] = {}}
	self:init_options()
end

function CornerButtons:destroy()
	self:destroy_elements()
	Element.destroy(self)
end

--- 解析 `corner_controls` 选项。
---
--- 语法：`top-left:名字1;top-right:名字2,名字3`
---   · 分号分隔角落，逗号分隔按钮；
---   · 容错：允许照抄底部栏的 `button:<名字>` 写法；空段 / 未知角落 / 缺冒号都只跳过，
---     **不 error、不退出**（这个选项只影响排版，写错了顶多角标少几个按钮）。
---@param value any
---@return table<string, string[]>
local function parse_corner_controls(value)
	local groups = {['top-left'] = {}, ['top-right'] = {}}
	if type(value) ~= 'string' or value == '' then return groups end

	for _, segment in ipairs(split(value, ';')) do
		segment = trim(segment)
		if segment ~= '' then
			local corner, names = segment:match('^([%w%-_]+)%s*:%s*(.*)$')
			if not corner then
				msg.warn('corner_controls：忽略无法解析的段「' .. segment .. '」（应为 角名:按钮1,按钮2）')
			elseif not groups[corner] then
				msg.warn('corner_controls：忽略不支持的角落「' .. corner .. '」（只支持 top-left / top-right）')
			else
				for _, name in ipairs(comma_split(names)) do
					name = trim(name):gsub('^button%s*:%s*', '')
					if name ~= '' then groups[corner][#groups[corner] + 1] = name end
				end
			end
		end
	end

	return groups
end

function CornerButtons:init_options()
	self:destroy_elements()

	local groups = parse_corner_controls(options.corner_controls)
	local index = 0
	for _, corner in ipairs(CORNERS) do
		for _, name in ipairs(groups[corner]) do
			index = index + 1
			local button = ManagedButton:new('corner_button_' .. index, {
				name = name,
				render_order = self.render_order,
				anchor_id = 'corner_buttons',
				-- 受管按钮被下发了 hide=true 时，这一排要重新收拢（与 Controls 的做法一致）
				on_hide = function() self:update_dimensions() end,
			})
			self.buttons[corner][#self.buttons[corner] + 1] = button
		end
	end

	-- 自检证据（ANGLE 里看不到 ASS 图层，只能由脚本自己说）：
	-- 打开 SAKANA_MPV_VERBOSE=1 后日志里会打印这一行，确认选项确实被读到、按钮确实建出来了。
	local summary = {}
	for _, corner in ipairs(CORNERS) do
		local names = {}
		for _, button in ipairs(self.buttons[corner]) do names[#names + 1] = button.name or '?' end
		summary[#summary + 1] = corner .. '=' .. (#names > 0 and table.concat(names, ',') or '-')
	end
	msg.info('[sakana-corner] corner_controls="' .. tostring(options.corner_controls) ..
		'" → ' .. table.concat(summary, '; '))

	self:update_dimensions()
end

--- 计算按钮位置。布局刻意做得很简单：
---   · 尺寸 / 间距 / 边距分别复用 options.controls_size / controls_spacing / controls_margin，
---     所以和底部栏是同一套尺寸，主题缩放（state.scale）自动跟着走；
---   · 左上角左对齐，右上角右对齐；组内顺序保持配置里的从左到右（详情 · 截图 · 播放流详情）。
function CornerButtons:update_dimensions()
	local size = round(options.controls_size * state.scale)
	local spacing = round(options.controls_spacing * state.scale)
	local margin = round(options.controls_margin * state.scale)
	local border = Elements:v('window_border', 'size', 0)

	local left_count = #self.buttons['top-left']
	local right_count = #self.buttons['top-right']

	-- 有媒体在播才启用；display 还没初始化（无窗口 / 首帧前）也不要摆位置。
	self.enabled = display.width > 0 and state.path ~= nil and not state.is_idle
		and (left_count + right_count > 0)

	if not self.enabled then
		self.ax, self.ay, self.bx, self.by = 0, 0, 0, 0
		self:reset_proximity()
		for _, corner in ipairs(CORNERS) do
			for _, button in ipairs(self.buttons[corner]) do
				button.enabled = false
				button.ax, button.ay, button.bx, button.by = 0, 0, 0, 0
				button:reset_proximity()
			end
		end
		if self._layout_signature ~= 'disabled' then
			self._layout_signature = 'disabled'
			msg.verbose('[sakana-corner] 未启用（没有媒体在播，或画面尺寸还没就绪）')
		end
		Elements:update_proximities()
		request_render()
		return
	end

	local ay = border + margin
	local by = ay + size
	local left_ax = border + margin
	local right_bx = display.width - border - margin

	-- 容器 = 画面顶部那一条（左右两个角之间）。proximity 只看这个矩形，
	-- 所以“鼠标接近顶部”就会显示，“鼠标在画面中间”就不会 —— 与 uosc 自带元素同一套判定。
	self.ax, self.ay, self.bx, self.by = left_ax, ay, right_bx, by

	-- 左上角：从左边界往右排
	local x = left_ax
	for _, button in ipairs(self.buttons['top-left']) do
		if button.hide == true then
			button.enabled = false
		else
			button.enabled = true
			button:set_coordinates(round(x), ay, round(x + size), by)
			x = x + size + spacing
		end
	end

	-- 右上角：整组右对齐（先量出可见按钮总宽，再从右边界倒推起点），组内顺序仍是配置顺序
	local visible = {}
	for _, button in ipairs(self.buttons['top-right']) do
		if button.hide == true then
			button.enabled = false
		else
			visible[#visible + 1] = button
		end
	end
	local total_width = #visible > 0 and (#visible * size + (#visible - 1) * spacing) or 0
	x = right_bx - total_width
	for _, button in ipairs(visible) do
		button.enabled = true
		button:set_coordinates(round(x), ay, round(x + size), by)
		x = x + size + spacing
	end

	-- 排障用（verbose 级别，正常播放不输出）：几何真变了才打一行。
	-- 无窗口 / 真机验证都靠这行确认“角标到底摆在哪、尺寸是否跟着主题缩放”。
	local signature = string.format('%d,%d,%d,%d', self.ax, self.ay, self.bx, self.by)
	if signature ~= self._layout_signature then
		self._layout_signature = signature
		msg.verbose(string.format('[sakana-corner] 布局 区域=(%s) 按钮=%dpx 间距=%dpx 左上=%d 右上=%d',
			signature, size, spacing, left_count, right_count))
	end

	Elements:update_proximities()
	request_render()
end

function CornerButtons:destroy_elements()
	for _, corner in ipairs(CORNERS) do
		for _, button in ipairs(self.buttons[corner]) do button:destroy() end
		self.buttons[corner] = {}
	end
end

-- 媒体开始 / 结束、窗口尺寸、窗口边框、选项变化都会影响角标，按 uosc 的事件约定挂上。
function CornerButtons:on_prop_path() self:update_dimensions() end
function CornerButtons:on_prop_is_idle() self:update_dimensions() end
function CornerButtons:on_prop_border() self:update_dimensions() end
function CornerButtons:on_display() self:update_dimensions() end

function CornerButtons:on_options()
	self:init_options()
end

return CornerButtons

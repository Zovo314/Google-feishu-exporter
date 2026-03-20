# 飞书文档导出器

一个 Chrome 扩展，将飞书（Feishu/Lark）文档导出为 **HTML、PDF、Word、Markdown** 四种格式，保留完整格式、样式和图片。

## 功能特性

- **4 种导出格式**：HTML / PDF / Word (.doc) / Markdown (.md)
- 导出完整文档格式（标题、正文、列表、代码块、表格等）
- 图片自动转换为 Base64 内嵌，导出文件完全离线可用
- 使用滚动捕获技术，兼容飞书虚拟渲染器（仅渲染可视区域的内容）
- 导出进度实时显示

## 格式说明

| 格式 | 说明 |
|------|------|
| HTML | 独立 HTML 文件，保留完整样式，离线可用 |
| PDF | 在新标签页打开打印预览，选择「另存为 PDF」保存 |
| Word | `.doc` 格式，可用 Word 或 LibreOffice 直接打开 |
| Markdown | `.md` 格式，适合 Obsidian、Typora 等 Markdown 编辑器 |

## 安装

### 从源码安装（开发者模式）

1. 克隆或下载本仓库
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角**开发者模式**
4. 点击**加载已解压的扩展程序**，选择本项目根目录
5. 扩展安装完成

## 使用方法

1. 在 Chrome 中打开飞书/Lark 文档页面
2. 点击浏览器工具栏中的扩展图标
3. 选择导出格式（HTML / PDF / Word / MD）
4. 点击导出按钮，等待进度完成

## 兼容性

- 飞书（feishu.cn）
- Lark（larksuite.com）

## 技术实现

飞书文档使用虚拟渲染，仅将可视区域的内容挂载到 DOM。本扩展通过以下方式处理：

1. 自动滚动文档，逐步捕获进入视口的内容块
2. 对每个块进行深度克隆并内联 CSS 样式
3. 将 Blob URL 图片转换为 Base64
4. 组装为完整 HTML，再按需转换为目标格式：
   - **Markdown**：遍历 DOM 树转换为 Markdown 语法
   - **Word**：HTML 添加 Office XML 命名空间，Word 可直接识别打开
   - **PDF**：HTML 存入扩展临时存储，在打印页调用 `window.print()`

## 许可证

[MIT](LICENSE)

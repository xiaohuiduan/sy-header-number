/**
 * 思源笔记API工具函数
 */

/**
 * 将数组按指定大小分块
 */
function chunkArray<T>(array: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

/**
 * 语义化版本号比较
 * @returns v1 > v2 返回 1，v1 < v2 返回 -1，相等返回 0
 */
export function compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split(".").map(Number);
    const parts2 = v2.split(".").map(Number);
    const len = Math.max(parts1.length, parts2.length);
    for (let i = 0; i < len; i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

/**
 * 批量更新块内容（支持分块）
 * @param contents 块ID到内容的映射
 * @param dataType 块数据格式，"dom" 或 "markdown"
 * @param useBulkApi 是否使用批量更新API
 * @param chunkSize 分块大小，0 表示不分块
 */
export async function batchUpdateBlockContent(
    contents: Record<string, string>,
    dataType: "dom" | "markdown" = "dom",
    useBulkApi = false,
    chunkSize = 0
): Promise<void> {
    const entries = Object.entries(contents);
    if (entries.length === 0) return;

    if (useBulkApi) {
        const chunks = chunkSize > 0 ? chunkArray(entries, chunkSize) : [entries];
        for (const chunk of chunks) {
            const toUpdateList = chunk.map(([id, content]) => ({
                id,
                data: content,
                dataType
            }));
            const response = await fetch("/api/block/batchUpdateBlock", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ blocks: toUpdateList })
            });
            if (!response.ok) {
                throw new Error("批量更新失败");
            }
            await response.json();
        }
    } else {
        const chunks = chunkSize > 0 ? chunkArray(entries, chunkSize) : [entries];
        for (const chunk of chunks) {
            await Promise.all(
                chunk.map(([id, content]) =>
                    fetch("/api/block/updateBlock", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id, data: content, dataType })
                    }).then(async (response) => {
                        if (!response.ok) {
                            throw new Error(`更新块 ${id} 失败`);
                        }
                        return response.json();
                    })
                )
            );
        }
    }
}

/**
 * 获取思源笔记版本号
 */
export async function getVersion(): Promise<string> {
    const response = await fetch("/api/system/version", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
        throw new Error("获取版本号失败");
    }
    const data = await response.json();
    return data.data;
}

/**
 * 获取文档中所有标题块（按文档顺序排列）
 * 使用 /api/outline/getDocOutline API 获取大纲，天然按文档从上到下顺序排列
 *
 * 大纲 API 数据结构：
 * - 顶层 outline 项本身就是标题（type="outline", nodeType="NodeHeading"），用 name 字段存标题文本
 * - outline 项的 blocks 数组存放其子标题（h3/h4/...），子标题用 content 字段存文本
 * - 子标题可能有 children（更深层的子标题）
 *
 * @param docId 文档ID
 * @returns 标题块列表，按文档顺序排列，每个块包含 id/content/subtype 字段
 */
export async function getDocHeaderBlocks(docId: string): Promise<any[]> {
    if (!docId) {
        console.warn("getDocHeaderBlocks: docId 为空");
        return [];
    }

    try {
        const response = await fetch("/api/outline/getDocOutline", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: docId })
        });

        if (!response.ok) {
            console.error("getDocHeaderBlocks: API 响应失败", response.status);
            return [];
        }

        const data = await response.json();
        const outline: any[] = data.data || [];
        if (outline.length === 0) return [];

        // 深度优先遍历大纲树，展平为有序标题列表
        const result: any[] = [];

        function collectBlock(block: any) {
            // 收集 blocks 中的子标题（h3/h4/...，type="NodeHeading"）
            if (block.type === "NodeHeading" && block.subType) {
                result.push({
                    id: block.id,
                    content: block.content || block.name || "",
                    subtype: block.subType,
                    type: block.type,
                });
            }
            // 递归遍历子标题（保证文档从上到下顺序）
            if (block.children && block.children.length > 0) {
                for (const child of block.children) {
                    collectBlock(child);
                }
            }
        }

        // 遍历顶层 outline，每个 outline 项本身也是标题
        for (const item of outline) {
            // 顶层项是标题（nodeType="NodeHeading"），用 name 字段作为 content
            if (item.nodeType === "NodeHeading" && item.subType) {
                result.push({
                    id: item.id,
                    content: item.name || item.content || "",
                    subtype: item.subType,
                    type: item.nodeType,
                });
            }
            // 然后处理其 blocks 子标题（DFS 保证文档顺序）
            if (item.blocks && item.blocks.length > 0) {
                for (const block of item.blocks) {
                    collectBlock(block);
                }
            }
        }

        return result;
    } catch (error) {
        console.error("getDocHeaderBlocks: 获取大纲失败", error);
        return [];
    }
}

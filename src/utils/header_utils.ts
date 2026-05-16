/**
 * 标题序号工具函数
 */

/**
 * 将数字转换为中文数字
 */
export function num2Chinese(num: number): string {
    const units = ["", "十", "百", "千", "万"];
    const numbers = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

    if (num === 0) return numbers[0];
    if (num < 0) return "负" + num2Chinese(-num);
    if (num < 10) return numbers[num];

    let result = "";
    let temp = num;
    let unitIndex = 0;

    while (temp > 0) {
        const digit = temp % 10;
        if (digit === 0) {
            if (result && result[0] !== numbers[0]) {
                result = numbers[0] + result;
            }
        } else {
            result = numbers[digit] + units[unitIndex] + result;
        }
        temp = Math.floor(temp / 10);
        unitIndex++;
    }

    result = result.replace(/零+$/, "");
    result = result.replace(/零+/g, "零");
    if (result.startsWith("一十")) {
        result = result.substring(1);
    }

    return result;
}

/**
 * 获取标题的相对层级
 */
function getRelativeHeaderLevel(level: number, existingLevels: number[]): number {
    return existingLevels.indexOf(level);
}

/**
 * 生成标题序号
 */
export function generateHeaderNumber(
    level: number,
    counters: number[],
    formats: string[],
    useChineseNumbers: boolean[],
    existingLevels: number[] = []
): [string, number[]] {
    const newCounters = [...counters];
    let actualLevel: number = 0;
    let relativeLevel: number = 0;

    if (existingLevels.length === 0) {
        actualLevel = level - 1;
        newCounters[actualLevel]++;
        for (let i = actualLevel + 1; i < newCounters.length; i++) {
            newCounters[i] = 0;
        }
    } else {
        relativeLevel = getRelativeHeaderLevel(level, existingLevels);
        newCounters[relativeLevel]++;
        for (let i = relativeLevel + 1; i < newCounters.length; i++) {
            newCounters[i] = 0;
        }
    }

    const currentLevel = existingLevels.length === 0 ? actualLevel : relativeLevel;
    const format = formats[currentLevel];

    let result = format;
    const placeholders = format.match(/\{(\d+)\}/g) || [];

    for (const placeholder of placeholders) {
        const match = placeholder.match(/\{(\d+)\}/);
        if (!match) continue;
        const index = parseInt(match[1]) - 1;
        const shouldUseChinese = useChineseNumbers[currentLevel];
        const num = newCounters[index];
        const numStr = shouldUseChinese ? num2Chinese(num) : num.toString();
        result = result.replace(placeholder, numStr);
    }

    return [result, newCounters];
}

/**
 * 根据格式字符串构建用于匹配序号前缀的正则表达式
 * @param format 序号格式
 * @returns 匹配序号前缀的正则表达式，如果格式无效则返回 null
 */
export function buildFormatRegex(format: string): RegExp | null {
    const placeholders = format.match(/\{(\d+)\}/g) || [];
    if (placeholders.length === 0) return null;

    let regexPattern = format;

    // 先替换占位符为临时标记
    const tempMarkers: string[] = [];
    placeholders.forEach((placeholder, index) => {
        const marker = `__PH_${index}__`;
        tempMarkers.push(marker);
        regexPattern = regexPattern.replace(placeholder, marker);
    });

    // 转义正则特殊字符
    regexPattern = regexPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 替换标记为数字/中文数字匹配模式
    const numberPattern = "[\\d\\u4e00-\\u9fa5]+";
    tempMarkers.forEach((marker) => {
        regexPattern = regexPattern.replace(marker, numberPattern);
    });

    try {
        return new RegExp(`^${regexPattern}`);
    } catch {
        return null;
    }
}

/**
 * 从文本中移除序号前缀（精确清除）
 * 优先级：1. 缓存前缀精确移除 → 2. 格式正则匹配 → 3. 通用正则兜底
 * @param content 标题内容（不含 markdown 标记）
 * @param cachedPrefix 已知的序号前缀（来自增量更新缓存）
 * @param formats 格式配置列表
 * @param level 标题级别（1-6）
 * @returns 移除序号后的内容
 */
export function stripNumberPrefix(
    content: string,
    cachedPrefix?: string,
    formats?: string[],
    level?: number
): string {
    // 归一化：将 &nbsp; 替换为普通空格，确保正则能正确匹配序号前缀
    let normalized = content.replace(/&nbsp;/g, " ");

    // 优先级1：使用缓存前缀精确移除（缓存前缀也需归一化比较）
    if (cachedPrefix) {
        const normalizedPrefix = cachedPrefix.replace(/&nbsp;/g, " ");
        if (normalized.startsWith(normalizedPrefix)) {
            return normalized.substring(normalizedPrefix.length);
        }
    }

    // 优先级2：使用格式正则匹配
    if (formats && formats.length > 0) {
        // 先尝试当前级别的格式
        if (level !== undefined) {
            const levelIndex = level - 1;
            if (levelIndex >= 0 && levelIndex < formats.length) {
                const regex = buildFormatRegex(formats[levelIndex]);
                if (regex) {
                    const match = normalized.match(regex);
                    if (match) {
                        return normalized.substring(match[0].length);
                    }
                }
            }
        }

        // 再尝试其他格式（从长到短，更具体的格式优先）
        const sortedFormats = [...formats]
            .filter(f => f.trim().length > 0)
            .sort((a, b) => b.length - a.length);
        for (const format of sortedFormats) {
            const regex = buildFormatRegex(format);
            if (regex) {
                const match = normalized.match(regex);
                if (match) {
                    return normalized.substring(match[0].length);
                }
            }
        }
    }

    // 优先级3：通用正则兜底（匹配多段 "1.2.3 " 和单段 "1. "）
    const numberPattern = /^[\d\u4e00-\u9fa5]+(?:\.[\d\u4e00-\u9fa5]+)*\.\s+/;
    let newContent = normalized;
    let previousContent: string;
    do {
        previousContent = newContent;
        newContent = newContent.replace(numberPattern, "");
    } while (newContent !== previousContent);

    return newContent;
}

/**
 * 基于块列表计算序号
 * @param blocks 标题块列表
 * @param formats 序号格式配置
 * @param useChineseNumbers 是否使用中文数字
 * @param enabledLevels 每级标题是否启用编号
 * @returns 块ID到序号的映射（禁用的级别返回空字符串）
 */
export function calculateHeaderNumbersForBlocks(
    blocks: any[],
    formats: string[],
    useChineseNumbers: boolean[],
    enabledLevels: boolean[] = [true, true, true, true, true, true]
): Record<string, string> {
    const result: Record<string, string> = {};
    const counters = [0, 0, 0, 0, 0, 0];

    // 收集所有存在的标题级别并排序
    const existingLevels = Array.from(
        new Set(
            blocks
                .map((block) => parseInt(block.subtype?.substring(1) || "0"))
                .filter((level) => level > 0)
        )
    ).sort((a, b) => a - b);

    for (const block of blocks) {
        const subtype = block.subtype;
        const level = parseInt(subtype?.substring(1) || "0");

        if (level === 0) continue;

        // 生成新序号（计数器逻辑不变）
        const [number, newCounters] = generateHeaderNumber(
            level,
            counters,
            formats,
            useChineseNumbers,
            existingLevels
        );

        counters.splice(0, counters.length, ...newCounters);

        // 检查此级别是否启用编号
        const levelIndex = level - 1;
        result[block.id] = enabledLevels[levelIndex] ? number : "";
    }

    return result;
}

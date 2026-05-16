/**
 * 插件配置接口
 */
export interface IPluginConfig {
    // 每级标题的序号格式
    formats: string[];
    // 是否使用中文数字
    useChineseNumbers: boolean[];
    // 每级标题是否启用编号
    enabledLevels: boolean[];
    // 默认是否启用
    defaultEnabled: boolean;
    // 是否实时更新
    realTimeUpdate: boolean;
    // 轮询间隔（秒），0 表示禁用轮询
    pollInterval: number;
    // 每个文档的启用状态
    docEnableStatus: Record<string, boolean>;
}

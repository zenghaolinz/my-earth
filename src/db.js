// src/db.js
import Dexie from 'dexie';

// 创建名为 'FootprintApp' 的数据库
export const db = new Dexie('daloudi');

// 定义表结构
// ++id 代表自增主键
// 我们只把需要查询的字段写在这里 (countryName, lat, lng)
// 照片文件本身 (blob) 不需要写在 schema 里，但可以直接存进去
db.version(1).stores({
  photos: '++id, countryName, lat, lng, timestamp' 
});
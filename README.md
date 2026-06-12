# my-earth

一个基于 React、Vite 和 `react-globe.gl` 的个人地球足迹应用。应用会在 3D 地球上展示照片位置、国家/地区边界和聚合点，适合用来记录旅行、生活轨迹或照片足迹。

## 功能

- 3D 地球交互展示
- 照片上传与 EXIF GPS 信息解析
- 图片压缩后本地保存
- 基于经纬度的国家/地区识别
- 照片点位聚合展示
- 中国湖南区域细节视图
- 浏览器本地 IndexedDB 数据库存储

## 数据存储说明

照片和位置信息使用 Dexie 写入浏览器 IndexedDB，数据保存在当前用户的本地浏览器中。

这意味着：

- 数据不会自动上传到 GitHub
- 数据不会自动同步到其他设备
- 清理浏览器站点数据可能会删除本地照片记录
- 更换浏览器或设备后需要重新导入数据

## 技术栈

- React 19
- Vite 7
- Three.js
- react-globe.gl
- Dexie / IndexedDB
- ExifReader
- Supercluster
- d3-geo

## 开始使用

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

构建生产版本：

```bash
npm run build
```

本地预览构建结果：

```bash
npm run preview
```

运行代码检查：

```bash
npm run lint
```

## 目录结构

```text
my-earth/
├── public/              # 静态资源
├── src/
│   ├── assets/          # 应用资源图片
│   ├── data/            # 国家/地区数据
│   ├── App.jsx          # 主应用
│   ├── db.js            # IndexedDB 配置
│   ├── main.jsx         # 应用入口
│   └── utils.js         # 地理计算工具
├── package.json
└── vite.config.js
```

## 注意事项

- 上传照片需要包含 GPS EXIF 信息，才能自动定位到地球上。
- IndexedDB 数据只存在本地浏览器，不属于代码仓库内容。
- `node_modules` 和构建产物已通过 `.gitignore` 排除。

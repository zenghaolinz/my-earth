// src/utils.js
import * as d3 from 'd3-geo';

// EXIF 格式转十进制经纬度
export const convertDMSToDD = (dms, ref) => {
  if (!dms || dms.length < 3) return 0;
  const degrees = dms[0].numerator / dms[0].denominator; // 有些库解析出来是对象
  const minutes = dms[1].numerator / dms[1].denominator;
  const seconds = dms[2].numerator / dms[2].denominator;
  
  let dd = degrees + minutes / 60 + seconds / 3600;
  
  if (ref === 'S' || ref === 'W') {
    dd = dd * -1;
  }
  return dd; // 返回十进制坐标
};

// 判断一个点是否在某个国家内 (Point in Polygon)
// point: [lng, lat]
// feature: GeoJSON feature (Country)
export const isPointInCountry = (point, feature) => {
  return d3.geoContains(feature, point);
};
import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import Globe from 'react-globe.gl';
import * as THREE from 'three';
import ExifReader from 'exifreader';
import Supercluster from 'supercluster';
import countriesGeoJson from './final.json';
import hunanGeoJson from './hunan.json';
import { db } from './db';
import { isPointInCountry } from './utils';
import { getCountryInfo } from './data/countryData';

// --- 基础配置 ---
const CHINA_COORDS = { lat: 28, lng: 112, altitude: 1.5 };
const HUNAN_VIEW_THRESHOLD = 1.0;
const CLUSTER_RADIUS_CONFIG = { min: 100, max: 200 };
const ALTITUDE_THRESHOLD = 0.8;
const CLOSE_UP_HEIGHT = 0.015;
const assetUrl = (path) => `${import.meta.env.BASE_URL}${path}`;

const getZoomFromAltitude = (alt) => Math.max(0, Math.min(20, Math.floor(5 - Math.log2(alt))));

const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// 虽然不显示，但为了兼容性，我们生成一个极小的透明图，或者继续生成卡片但隐藏它
// 这里继续生成卡片以保持数据结构完整，但会在UI层面完全过滤掉它
const createPlaceholderImage = (text, width = 300, height = 300) => {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    // 生成一个简单的纯色块，实际上用户不会再看到了
    ctx.fillStyle = '#007AFF';
    ctx.fillRect(0, 0, width, height);
    
    canvas.toBlob((blob) => { resolve(blob); }, 'image/jpeg', 0.5);
  });
};

const compressImage = (file, maxWidth = 300, quality = 0.7) => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width; let height = img.height;
        if (width > height) { if (width > maxWidth) { height *= maxWidth / width; width = maxWidth; } }
        else { if (height > maxWidth) { width *= maxWidth / height; height = maxWidth; } }
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => { resolve(blob); }, 'image/jpeg', quality);
      };
    };
  });
};

const getFeatureCenter = (feature) => {
  if (!feature || !feature.geometry) return null;
  const type = feature.geometry.type;
  let coordinates = feature.geometry.coordinates;
  let targetPolygon = coordinates;
  if (type === 'MultiPolygon') {
    let maxPoints = 0; let maxIdx = 0;
    coordinates.forEach((poly, idx) => { if (poly[0] && poly[0].length > maxPoints) { maxPoints = poly[0].length; maxIdx = idx; } });
    targetPolygon = coordinates[maxIdx];
  } else if (type === 'Polygon') { targetPolygon = coordinates; } else { return null; }
  const exteriorRing = targetPolygon[0]; if (!Array.isArray(exteriorRing)) return null;
  let minLng = 180, maxLng = -180, minLat = 90, maxLat = -90;
  exteriorRing.forEach(coord => { const [lng, lat] = coord; if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng; if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; });
  if (minLng > maxLng || minLat > maxLat) return null;
  return { lng: (minLng + maxLng) / 2, lat: (minLat + maxLat) / 2 };
};

const parseExifDate = (dateStr) => {
  if (!dateStr) return null;
  try {
    const formatted = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1/$2/$3');
    const timestamp = Date.parse(formatted);
    return isNaN(timestamp) ? null : timestamp;
  } catch (e) { return null; }
};

const formatForInput = (timestamp) => {
  const d = new Date(timestamp);
  const pad = (n) => n < 10 ? '0' + n : n;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// --- GPS 解析函数 ---
const calculateGPS = (tag, refTag) => {
  if (!tag) return null;
  if (typeof tag.description === 'number' && !isNaN(tag.description)) {
      let coord = tag.description;
      if (refTag) {
          const refRaw = Array.isArray(refTag.value) ? refTag.value[0] : refTag.value;
          const refStr = String(refRaw || '').toUpperCase();
          if (refStr.includes('S') || refStr.includes('W')) coord = -1 * Math.abs(coord);
      }
      return coord;
  }
  if (!tag.value) return null;
  const val = tag.value;
  if (Array.isArray(val) && val.length === 3) {
    const getVal = (item) => {
      if (typeof item === 'number') return item;
      if (item && typeof item.numerator === 'number' && item.denominator) return item.numerator / item.denominator;
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'number') return item[0] / item[1];
      return 0;
    };
    const d = getVal(val[0]);
    const m = getVal(val[1]);
    const s = getVal(val[2]);
    let coordinate = d + (m / 60) + (s / 3600);
    if (refTag) {
      const refRaw = Array.isArray(refTag.value) ? refTag.value[0] : refTag.value;
      const refStr = String(refRaw || '').toUpperCase();
      if (refStr.includes('S') || refStr.includes('W')) coordinate = -1 * Math.abs(coordinate);
    }
    return coordinate;
  }
  return null;
};

const chinaProvinceNames = ["Beijing", "Tianjin", "Hebei", "Shanxi", "Inner Mongolia", "Nei Mongol", "Liaoning", "Jilin", "Heilongjiang", "Shanghai", "Jiangsu", "Zhejiang", "Anhui", "Fujian", "Jiangxi", "Shandong", "Henan", "Hubei", "Hunan", "Guangdong", "Guangxi", "Hainan", "Chongqing", "Sichuan", "Guizhou", "Yunnan", "Tibet", "Xizang", "Shaanxi", "Gansu", "Qinghai", "Ningxia", "Xinjiang", "Hong Kong", "Macao", "Taiwan"];

const throttle = (fn, wait) => {
  let last = 0; let timeout = null;
  return (...args) => {
    const now = Date.now(); const remaining = wait - (now - last);
    if (remaining <= 0) { if (timeout) { clearTimeout(timeout); timeout = null; } last = now; fn(...args); }
    else if (!timeout) { timeout = setTimeout(() => { last = Date.now(); timeout = null; fn(...args); }, remaining); }
  };
};

function App() {
  const globeEl = useRef();
  const globalFileInputRef = useRef(); 
  const localFileInputRef = useRef();

  const superclusterRef = useRef(null);
  const createdObjectUrls = useRef(new Set());
  const countryCache = useRef(new Map());
  const isProgrammaticMove = useRef(false);
  const userManuallyStoppedRef = useRef(false);
  const isUserInteractingRef = useRef(false);
  const isTouringRef = useRef(false);

  const [hoverD, setHoverD] = useState(null);
  const [selectedCountry, setSelectedCountry] = useState(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRotating, setIsRotating] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isDayMode, setIsDayMode] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [currentAltitude, setCurrentAltitude] = useState(2.5);
  const [photos, setPhotos] = useState([]);
  const [filteredMarkers, setFilteredMarkers] = useState([]);

  // Tour States
  const [isTouring, setIsTouring] = useState(false);
  const [tourStep, setTourStep] = useState(0);
  const [activeRipple, setActiveRipple] = useState(null);
  const [tourPlaylist, setTourPlaylist] = useState([]);

  // Playlist Editing States
  const [isEditingPlaylist, setIsEditingPlaylist] = useState(false);
  const [groupedPhotos, setGroupedPhotos] = useState({});
  const [editingTimeId, setEditingTimeId] = useState(null);
  const [selectorModalIndex, setSelectorModalIndex] = useState(null);

  // --- 发牌动画状态 ---
  const [isDealing, setIsDealing] = useState(false);
  const [dealProgress, setDealProgress] = useState(0);

  const baseAltitude = useMemo(() => {
    return currentAltitude > ALTITUDE_THRESHOLD ? 0 : CLOSE_UP_HEIGHT;
  }, [currentAltitude]);

  const baseWorldData = useMemo(() => countriesGeoJson.features || countriesGeoJson, []);

  const fixedHunanData = useMemo(() => {
    let features = hunanGeoJson.features || hunanGeoJson;
    return features.map(f => {
      const newF = JSON.parse(JSON.stringify(f));
      if (newF.geometry.type === 'Polygon') newF.geometry.coordinates.forEach(ring => ring.reverse());
      else if (newF.geometry.type === 'MultiPolygon') newF.geometry.coordinates.forEach(polygon => polygon.forEach(ring => ring.reverse()));
      newF.properties.isHunanCity = true;
      return newF;
    });
  }, []);

  const polygonsData = useMemo(() => {
    if (currentAltitude > HUNAN_VIEW_THRESHOLD) return baseWorldData;
    else {
      const worldWithoutHunan = baseWorldData.filter(p => { const name = p.properties.ADMIN || p.properties.name; return name !== 'Hunan' && name !== '湖南省'; });
      return [...worldWithoutHunan, ...fixedHunanData];
    }
  }, [currentAltitude, baseWorldData, fixedHunanData]);

  const isChinaRegion = useCallback((d) => {
    if (!d || !d.properties) return false;
    const p = d.properties;
    if (p.isHunanCity) return true;
    const name = p.ADMIN || p.name;
    if (d.properties.isChina === true) return true;
    return chinaProvinceNames.includes(name) || p.adm0_a3 === 'CHN' || p.iso_a2 === 'CN';
  }, []);

  const isSelectedCountryChina = useMemo(() => {
    if (!selectedCountry) return false;
    const name = selectedCountry.properties.ADMIN || selectedCountry.properties.name;
    return name === 'China' || name === '中华人民共和国';
  }, [selectedCountry]);

  // --- 上传处理 ---
  const processUploadedFiles = async (e, isLocalContext) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setIsUploading(true);

    let forceCenterLat = 0, forceCenterLng = 0, forceCountryName = null;
    if (isLocalContext && selectedCountry) {
        const center = getFeatureCenter(selectedCountry);
        if (center) {
            forceCenterLat = center.lat;
            forceCenterLng = center.lng;
        }
        forceCountryName = selectedCountry.properties.ADMIN || selectedCountry.properties.name;
    }

    const processedResults = await Promise.all(files.map(async (file) => {
      let lat, lng;
      let timestamp = file.lastModified || Date.now();
      let belongToCountry = 'Unknown';

      let gpsLat = null, gpsLng = null;
      try {
        const tags = await ExifReader.load(file);
        if (tags['DateTimeOriginal']) {
          const dateStr = tags['DateTimeOriginal'].description;
          const exifTime = parseExifDate(dateStr);
          if (exifTime) timestamp = exifTime;
        }
        const rawLat = calculateGPS(tags['GPSLatitude'], tags['GPSLatitudeRef']);
        const rawLng = calculateGPS(tags['GPSLongitude'], tags['GPSLongitudeRef']);
        if (rawLat !== null && rawLng !== null && !isNaN(rawLat) && !isNaN(rawLng)) {
            if (rawLat !== 0 && rawLng !== 0) {
                gpsLat = rawLat;
                gpsLng = rawLng;
            }
        }
      } catch (err) { }

      if (isLocalContext) {
          lat = forceCenterLat + (Math.random() - 0.5) * 0.1; 
          lng = forceCenterLng + (Math.random() - 0.5) * 0.1;
          belongToCountry = forceCountryName || 'Unknown';
      } else {
          if (gpsLat !== null && gpsLng !== null) {
              lat = gpsLat;
              lng = gpsLng;
              const key = `${lng.toFixed(3)},${lat.toFixed(3)}`;
              const cached = countryCache.current.get(key);
              if (cached) {
                  belongToCountry = cached;
              } else {
                  let found = fixedHunanData.find(f => isPointInCountry([lng, lat], f));
                  if (!found) found = baseWorldData.find(f => isPointInCountry([lng, lat], f));
                  belongToCountry = found?.properties.ADMIN || found?.properties.name || 'Unknown';
                  countryCache.current.set(key, belongToCountry);
              }
          } else {
              return null; 
          }
      }

      const thumbBlob = await compressImage(file);
      const photoRecord = { countryName: belongToCountry, lat, lng, timestamp: timestamp, fileBlob: file, thumbBlob: thumbBlob, isManual: false };
      const id = await db.photos.add(photoRecord);
      const url = URL.createObjectURL(thumbBlob);
      createdObjectUrls.current.add(url);
      return { ...photoRecord, id, url };
    }));

    const validPhotos = processedResults.filter(p => p !== null);

    setPhotos(prev => {
      const merged = [...prev, ...validPhotos];
      setTimeout(() => updateClusters(), 100);
      return merged;
    });

    setIsUploading(false);
    if (validPhotos.length > 0) {
      setIsRotating(false);
      if (globeEl.current) try { globeEl.current.controls().autoRotate = false; } catch (e) { }
    } else if (files.length > 0 && !isLocalContext) {
        alert("导入的图片未包含 GPS 信息，已全部跳过。");
    }
    
    if (e.target) e.target.value = '';
  };

  // --- 一键点亮 (无照片) ---
  const handleManualLightUp = async () => {
    if (!selectedCountry) return;
    
    // 获取中心点
    const center = getFeatureCenter(selectedCountry);
    if (!center) {
      alert("无法定位该区域中心，无法点亮");
      return;
    }

    const countryName = selectedCountry.properties.ADMIN || selectedCountry.properties.name;
    const cnName = getCountryInfo(countryName).cnName || countryName;

    const placeholderBlob = await createPlaceholderImage(cnName);
    
    // 生成带随机偏移的坐标
    const lat = center.lat + (Math.random() - 0.5) * 0.05;
    const lng = center.lng + (Math.random() - 0.5) * 0.05;
    const timestamp = Date.now();

    const photoRecord = {
      countryName: countryName,
      lat: lat,
      lng: lng,
      timestamp: timestamp,
      fileBlob: null, 
      thumbBlob: placeholderBlob,
      isManual: true // 标记为手动点亮
    };

    try {
      const id = await db.photos.add(photoRecord);
      const url = URL.createObjectURL(placeholderBlob);
      createdObjectUrls.current.add(url);
      
      const newPhoto = { ...photoRecord, id, url };
      setPhotos(prev => {
        const merged = [...prev, newPhoto];
        setTimeout(() => updateClusters(), 100);
        return merged;
      });
    } catch (e) {
      console.error("点亮失败", e);
      alert("点亮失败，请重试");
    }
  };

  const handleDeletePhoto = async (id, e) => { if (e) e.stopPropagation(); if (window.confirm('确定删除？')) { const toRemove = photos.find(p => p.id === id); if (toRemove && toRemove.url) { try { URL.revokeObjectURL(toRemove.url); createdObjectUrls.current.delete(toRemove.url); } catch (e) { } } await db.photos.delete(id); setPhotos(prev => prev.filter(p => p.id !== id)); } };
  const handleClearAll = async () => { if (window.confirm('确定清空？')) { await db.photos.clear(); createdObjectUrls.current.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { } }); createdObjectUrls.current.clear(); setPhotos([]); } };
  const toggleRotation = () => { if (isTouring) { stopTour(); return; } const next = !isRotating; setIsRotating(next); if (!globeEl.current) return; const controls = globeEl.current.controls(); if (next) { userManuallyStoppedRef.current = false; isProgrammaticMove.current = true; try { controls.autoRotate = true; } catch (e) { } setTimeout(() => { isProgrammaticMove.current = false; }, 300); } else { try { controls.autoRotate = false; } catch (e) { } userManuallyStoppedRef.current = true; } };
  const resetView = () => { if (isTouring) stopTour(); setSelectedCountry(null); setShowStats(false); isProgrammaticMove.current = true; flyTo(CHINA_COORDS, 2000); setIsRotating(true); if (globeEl.current) try { globeEl.current.controls().autoRotate = true; } catch (e) { } setTimeout(() => { isProgrammaticMove.current = false; }, 2200); };
  const handleCountryClick = (polygon) => { if (isTouring) stopTour(); setSelectedCountry(polygon); setShowStats(false); setIsRotating(false); if (globeEl.current) globeEl.current.controls().autoRotate = false; };
  const handleClusterClick = (clusterId, lat, lng) => { if (isTouring) stopTour(); const index = superclusterRef.current; if (!index) return; const expansionZoom = Math.min(index.getClusterExpansionZoom(clusterId), 20); const nextAlt = Math.pow(2, 6 - expansionZoom); flyTo({ lat, lng, altitude: nextAlt }, 1000); };

  const tourVisitedSet = useMemo(() => {
    if (!isTouring || tourPlaylist.length === 0) return new Set();
    const visited = new Set();
    for (let i = 0; i <= tourStep && i < tourPlaylist.length; i++) {
      const p = tourPlaylist[i];
      visited.add(p.countryName);
      const isInHunan = fixedHunanData.some(f => isPointInCountry([p.lng, p.lat], f));
      if (isInHunan) {
        visited.add('Hunan');
        visited.add('湖南省');
      }
      const cityFeature = fixedHunanData.find(f => isPointInCountry([p.lng, p.lat], f));
      if (cityFeature) visited.add(cityFeature.properties.ADMIN || cityFeature.properties.name);
    }
    return visited;
  }, [isTouring, tourStep, tourPlaylist, fixedHunanData]);

  useEffect(() => {
    if (photos.length === 0) { superclusterRef.current = null; setFilteredMarkers([]); return; }
    const index = new Supercluster({ radius: CLUSTER_RADIUS_CONFIG.max, maxZoom: 18, map: (props) => ({ imgUrl: props.imgUrl, countryName: props.countryName }), reduce: (accum, props) => { if (!accum.imgUrl) accum.imgUrl = props.imgUrl; } });
    
    // 🔥 过滤掉手动点亮的记录，不让它们出现在地球标记中
    const visiblePoints = photos.filter(p => !p.isManual);
    
    const points = visiblePoints.map(p => ({ type: 'Feature', properties: { cluster: false, id: p.id, imgUrl: p.url, countryName: p.countryName }, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }));
    index.load(points);
    superclusterRef.current = index;
    updateClusters();
  }, [photos]);

  const updateClusters = useCallback(() => {
    if (!superclusterRef.current || !globeEl.current) return;
    const pov = globeEl.current.pointOfView();
    const alt = pov && pov.altitude !== undefined ? pov.altitude : globeEl.current.pointOfView().altitude;
    const zoom = getZoomFromAltitude(alt);
    let dynamicRadius = CLUSTER_RADIUS_CONFIG.max;
    if (zoom > 3) dynamicRadius = 150;
    if (zoom > 6) dynamicRadius = 80;
    if (zoom > 10) dynamicRadius = 40;
    try { if (superclusterRef.current) superclusterRef.current.options.radius = dynamicRadius; } catch (e) { }
    const bbox = [-180, -90, 180, 90];
    const clusters = superclusterRef.current.getClusters(bbox, zoom);
    const markers = clusters.map(cluster => {
      const [lng, lat] = cluster.geometry.coordinates;
      const { cluster: isCluster, point_count: pointCount, imgUrl, id, countryName } = cluster.properties;
      return { id: isCluster ? `cluster-${cluster.id}` : id, lat, lng, isCluster: isCluster, pointCount: pointCount, url: imgUrl, countryName: countryName, clusterId: cluster.id };
    });
    setFilteredMarkers(markers);
    if (Math.abs(currentAltitude - alt) > 0.05) setCurrentAltitude(alt);
  }, [currentAltitude]);

  const statsData = useMemo(() => {
    if (photos.length === 0) return { km: 0, countries: 0, provinces: 0, visitedSet: new Set() };
    const sortedPhotos = [...photos].sort((a, b) => a.timestamp - b.timestamp);
    let totalKm = 0;
    // 距离计算：只计算真实照片的移动距离，避免手动点亮导致瞬移距离过大？ 
    // 或者也算进去？这里先包含，如果觉得奇怪可以 filter
    for (let i = 0; i < sortedPhotos.length - 1; i++) totalKm += getDistanceFromLatLonInKm(sortedPhotos[i].lat, sortedPhotos[i].lng, sortedPhotos[i + 1].lat, sortedPhotos[i + 1].lng);
    const visitedNames = new Set();
    let countryCount = 0; let provinceCount = 0; let hunanCityHasPhoto = false;
    photos.forEach(p => {
      const name = p.countryName; visitedNames.add(name);
      const cityFeature = fixedHunanData.find(f => isPointInCountry([p.lng, p.lat], f));
      if (cityFeature) { const cityName = cityFeature.properties.ADMIN || cityFeature.properties.name; visitedNames.add(cityName); hunanCityHasPhoto = true; }
      if (chinaProvinceNames.includes(name) || name.includes('省') || name.includes('市')) { const isHunanCity = fixedHunanData.some(f => (f.properties.ADMIN === name || f.properties.name === name)); if (isHunanCity) hunanCityHasPhoto = true; }
    });
    visitedNames.forEach(name => { if (chinaProvinceNames.includes(name) || name.includes('省') || name.includes('市')) provinceCount++; else if (name !== 'China' && name !== '中华人民共和国') countryCount++; });
    if (hunanCityHasPhoto) { visitedNames.add('Hunan'); visitedNames.add('湖南省'); }
    return { km: Math.round(totalKm), countries: countryCount, provinces: provinceCount, visitedSet: visitedNames };
  }, [photos, fixedHunanData]);

  const tourArcs = useMemo(() => {
    if (!isTouring || tourStep === 0 || tourPlaylist.length === 0) return [];
    const arcs = [];
    for (let i = 0; i < Math.min(tourStep, tourPlaylist.length - 1); i++) {
      arcs.push({
        startLat: tourPlaylist[i].lat, startLng: tourPlaylist[i].lng,
        endLat: tourPlaylist[i + 1].lat, endLng: tourPlaylist[i + 1].lng,
        color: i === tourStep - 1 ? ['#FFD700', 'rgba(255,215,0,0.1)'] : ['rgba(255,215,0,0.5)', 'rgba(255,215,0,0.1)']
      });
    }
    return arcs;
  }, [isTouring, tourStep, tourPlaylist]);

  const tourRings = useMemo(() => {
    if (!isTouring || !activeRipple) return [];
    return [{ lat: activeRipple.lat, lng: activeRipple.lng, maxR: 5, propagationSpeed: 2, repeatPeriod: 800 }];
  }, [isTouring, activeRipple]);

  const stopAutoRotateControls = useCallback((controls) => {
    if (!controls) return;
    if (isProgrammaticMove.current) return;
    try { if (controls.autoRotate) controls.autoRotate = false; } catch (e) { }
    if (!isTouringRef.current) { setIsRotating(false); userManuallyStoppedRef.current = true; }
  }, []);

  const flyTo = useCallback((pov, ms = 1000) => {
    if (!globeEl.current) return;
    isProgrammaticMove.current = true;
    try { globeEl.current.pointOfView(pov, ms); } catch (e) { try { globeEl.current.pointOfView(pov); } catch (err) { } }
    setTimeout(() => { isProgrammaticMove.current = false; }, ms + 150);
  }, []);

  const stopTour = useCallback(() => {
    isTouringRef.current = false;
    setIsTouring(false);
    setIsDealing(false); // 重置发牌
    setDealProgress(0);
    setTourStep(0);
    setActiveRipple(null);
    setTourPlaylist([]);
    if (globeEl.current) try { globeEl.current.controls().autoRotate = false; } catch (e) { }
    setIsRotating(false);
    setShowStats(true);
  }, []);

  const prepareTourPlaylist = useCallback(() => {
    // 巡游时排除掉手动点亮的“空记录”，避免播放空白
    const validPhotos = photos.filter(p => !p.isManual);
    if (validPhotos.length === 0) { alert("没有足够照片进行巡游"); return; }
    
    const groups = {};
    const sortedAll = [...validPhotos].sort((a, b) => a.timestamp - b.timestamp);
    const groupOrder = [];
    sortedAll.forEach(p => {
      const loc = p.countryName;
      if (!groups[loc]) { groups[loc] = []; groupOrder.push(loc); }
      groups[loc].push(p);
    });
    setGroupedPhotos(groups);
    const initialPlaylist = groupOrder.map(loc => {
      const list = groups[loc];
      const randomIndex = Math.floor(Math.random() * list.length);
      return list[randomIndex];
    });
    setTourPlaylist(initialPlaylist);
    setShowStats(false);
    setIsEditingPlaylist(true);
    setEditingTimeId(null);
    setSelectorModalIndex(null);
  }, [photos]);

  const openPhotoSelector = (index) => setSelectorModalIndex(index);
  const handleSelectPhotoForPlaylist = (photo) => { if (selectorModalIndex === null) return; const newPlaylist = [...tourPlaylist]; newPlaylist[selectorModalIndex] = photo; setTourPlaylist(newPlaylist); setSelectorModalIndex(null); };
  const handleSwapPhoto = (index, loc) => openPhotoSelector(index);
  const handleAddPhoto = (index, loc) => { const list = groupedPhotos[loc]; const newPlaylist = [...tourPlaylist]; const candidates = list.filter(p => !newPlaylist.some(item => item.id === p.id)); if (candidates.length > 0) { newPlaylist.splice(index + 1, 0, candidates[0]); setTourPlaylist(newPlaylist); } else { alert('该地点照片已全部选入'); } };
  const handleRemovePhotoFromPlaylist = (index) => { const newPlaylist = [...tourPlaylist]; newPlaylist.splice(index, 1); setTourPlaylist(newPlaylist); };
  const handleMovePhoto = (index, direction) => { const newPlaylist = [...tourPlaylist]; const targetIndex = index + direction; if (targetIndex < 0 || targetIndex >= newPlaylist.length) return; [newPlaylist[index], newPlaylist[targetIndex]] = [newPlaylist[targetIndex], newPlaylist[index]]; setTourPlaylist(newPlaylist); };
  const handleTimeChange = async (id, newDateString) => { if (!newDateString) return; const newTimestamp = new Date(newDateString).getTime(); const newPlaylist = tourPlaylist.map(p => { if (p.id === id) return { ...p, timestamp: newTimestamp }; return p; }); setTourPlaylist(newPlaylist); setPhotos(prev => prev.map(p => { if (p.id === id) return { ...p, timestamp: newTimestamp }; return p; })); try { await db.photos.update(id, { timestamp: newTimestamp }); } catch (e) { console.error("Save time failed", e); } setEditingTimeId(null); };

  const startTourExecution = useCallback(async () => {
    setIsEditingPlaylist(false);
    setIsTouring(true);
    isTouringRef.current = true;
    
    // 1. 发牌阶段
    setIsDealing(true);
    setDealProgress(0);
    setIsRotating(false);
    if (globeEl.current) try { globeEl.current.controls().autoRotate = false; } catch (e) { }

    flyTo({ lat: 28, lng: 110, altitude: 2.5 }, 1500);
    await new Promise(r => setTimeout(r, 1600));

    const dealingDuration = 2000;
    const startDealTime = Date.now();
    
    await new Promise(resolve => {
        const animateDeal = () => {
            if (!isTouringRef.current) { resolve(); return; }
            const now = Date.now();
            const p = Math.min((now - startDealTime) / dealingDuration, 1);
            const easeP = 1 - Math.pow(1 - p, 3);
            setDealProgress(easeP);
            if (p < 1) { requestAnimationFrame(animateDeal); } else { resolve(); }
        };
        requestAnimationFrame(animateDeal);
    });

    setIsDealing(false);
    await new Promise(r => setTimeout(r, 500));

    // 2. 巡游阶段
    setTourStep(0);
    setActiveRipple(null);

    const startP = tourPlaylist[0];
    flyTo({ lat: startP.lat, lng: startP.lng, altitude: 0.8 }, 1500);
    await new Promise(r => setTimeout(r, 1600));

    for (let i = 0; i < tourPlaylist.length; i++) {
      if (!isTouringRef.current) break;
      const p = tourPlaylist[i];
      setTourStep(i);
      setActiveRipple({ lat: p.lat, lng: p.lng });

      globeEl.current.pointOfView({ lat: p.lat, lng: p.lng, altitude: 0.35 }, 1500);
      await new Promise(r => setTimeout(r, 1500));

      if (!isTouringRef.current) break;
      await new Promise(r => setTimeout(r, 2000));

      if (i < tourPlaylist.length - 1) {
        const nextP = tourPlaylist[i + 1];
        const dist = getDistanceFromLatLonInKm(p.lat, p.lng, nextP.lat, nextP.lng);
        const flyAlt = dist > 2000 ? 1.5 : 0.8;
        globeEl.current.pointOfView({ altitude: flyAlt }, 1000);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (isTouringRef.current) { flyTo({ altitude: 2.0 }, 2000); setTimeout(() => stopTour(), 2000); }
  }, [tourPlaylist, flyTo, stopTour]);

  const handleGlobeReady = () => {
    if (!globeEl.current) return;
    flyTo(CHINA_COORDS, 0);
    const controls = globeEl.current.controls();
    try { controls.autoRotate = !!isRotating; } catch (e) { }
    controls.autoRotateSpeed = 0.5;
    const onStart = () => { isUserInteractingRef.current = true; if (isTouringRef.current) stopTour(); stopAutoRotateControls(controls); };
    const onEnd = () => { isUserInteractingRef.current = false; };
    const onChange = () => { if (globeEl.current) { const alt = globeEl.current.pointOfView().altitude; if (Math.abs(alt - currentAltitude) > 0.02) setCurrentAltitude(alt); updateClusters(); } };
    controls.addEventListener('start', onStart); controls.addEventListener('end', onEnd); controls.addEventListener('change', onChange);
    const onWheel = () => { if (isTouringRef.current) stopTour(); stopAutoRotateControls(controls); };
    const onTouchStart = () => { if (isTouringRef.current) stopTour(); stopAutoRotateControls(controls); };
    window.addEventListener('wheel', onWheel, { passive: true }); window.addEventListener('touchstart', onTouchStart, { passive: true });
    (globeEl.current._cleanupListeners = () => { try { controls.removeEventListener('start', onStart); } catch (e) { } try { controls.removeEventListener('end', onEnd); } catch (e) { } try { controls.removeEventListener('change', onChange); } catch (e) { } try { window.removeEventListener('wheel', onWheel); } catch (e) { } try { window.removeEventListener('touchstart', onTouchStart); } catch (e) { } });
    const scene = globeEl.current.scene();
    scene.children = scene.children.filter(obj => obj.type !== 'AmbientLight' && obj.type !== 'DirectionalLight');
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2); ambientLight.name = "globalAmbient";
    const dirLight = new THREE.DirectionalLight(0xffffff, 3.5); dirLight.name = "globalSun"; dirLight.position.set(1, 1, 1);
    scene.add(ambientLight); scene.add(dirLight);
    try { globeEl.current.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); } catch (e) { }
    loadPhotosFromDB();
  };

  useEffect(() => { return () => { if (globeEl.current && globeEl.current._cleanupListeners) try { globeEl.current._cleanupListeners(); } catch (e) { } createdObjectUrls.current.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) { } }); }; }, []);
  useEffect(() => { if (!globeEl.current) return; const scene = globeEl.current.scene(); const ambient = scene.children.find(c => c.name === "globalAmbient"); const sun = scene.children.find(c => c.name === "globalSun"); if (ambient && sun) { if (isDayMode) { ambient.intensity = 2.0; sun.intensity = 4.5; } else { ambient.intensity = 1.2; sun.intensity = 3.5; } } }, [isDayMode]);

  const loadPhotosFromDB = async () => { try { const savedPhotos = await db.photos.toArray(); const photosWithUrl = savedPhotos.map(p => { const thumbBlob = p.thumbBlob || null; const fileBlob = p.fileBlob || null; const url = URL.createObjectURL(thumbBlob || fileBlob); createdObjectUrls.current.add(url); return { ...p, url }; }); setPhotos(photosWithUrl); } catch (error) { console.error(error); } };

  const polygonStrokeColor = useCallback(d => {
    if (d === selectedCountry) return '#00C2FF';
    if (isSelectedCountryChina && isChinaRegion(d)) return '#00C2FF';
    const name = d.properties.ADMIN || d.properties.name;
    if (isTouring) {
      if (d.properties.isHunanCity) {
        if (tourVisitedSet.has('Hunan') || tourVisitedSet.has('湖南省')) return '#FFD700';
      }
      if (tourVisitedSet.has(name)) return '#FFD700';
    } else {
      if (showStats && statsData.visitedSet.has(name)) return '#FFD700';
    }
    if (isChinaRegion(d)) {
      if (currentAltitude < 0.8) return isDayMode ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.6)';
      return 'rgba(255, 255, 255, 0.4)';
    }
    return 'rgba(255, 255, 255, 0.2)';
  }, [selectedCountry, isSelectedCountryChina, isChinaRegion, showStats, statsData, currentAltitude, isDayMode, isTouring, tourVisitedSet]);

  const polygonCapColor = useCallback(d => {
    if (d === selectedCountry || (isSelectedCountryChina && isChinaRegion(d))) return 'rgba(0, 194, 255, 0.2)';
    if (d === hoverD) return 'rgba(255, 255, 255, 0.1)';
    const name = d.properties.ADMIN || d.properties.name;
    if (isTouring) {
      if (d.properties.isHunanCity) {
        if (tourVisitedSet.has('Hunan') || tourVisitedSet.has('湖南省')) return 'rgba(255, 215, 0, 0.5)';
      }
      if (tourVisitedSet.has(name)) return 'rgba(255, 215, 0, 0.5)';
    } else {
      if (showStats && statsData.visitedSet.has(name)) return 'rgba(255, 215, 0, 0.5)';
    }
    return 'rgba(0, 0, 0, 0)';
  }, [selectedCountry, isSelectedCountryChina, isChinaRegion, hoverD, showStats, statsData, isTouring, tourVisitedSet]);

  const polygonAltitude = useCallback(d => {
    if (d === selectedCountry || (isSelectedCountryChina && isChinaRegion(d))) return 0.015;
    const name = d.properties.ADMIN || d.properties.name;
    if (showStats && statsData.visitedSet.has(name)) return 0.01;
    return 0.005;
  }, [selectedCountry, isSelectedCountryChina, isChinaRegion, showStats, statsData]);

  const currentCountryPhotos = useMemo(() => {
    if (!selectedCountry) return [];
    if (isSelectedCountryChina) {
      return photos.filter(p => {
        const name = p.countryName;
        const isHunanCity = fixedHunanData.some(f => (f.properties.ADMIN === name || f.properties.name === name));
        return name === 'China' || name === '中华人民共和国' || chinaProvinceNames.includes(name) || name.includes('省') || name.includes('市') || isHunanCity;
      });
    }
    const name = selectedCountry.properties.ADMIN || selectedCountry.properties.name;
    return photos.filter(p => {
      if (p.countryName === name) return true;
      if (p.countryName.includes(name) || name.includes(p.countryName)) return true;
      return isPointInCountry([p.lng, p.lat], selectedCountry);
    });
  }, [selectedCountry, photos, isSelectedCountryChina, fixedHunanData]);

  // 🔥 分离真实照片和手动点亮记录
  const visiblePhotos = useMemo(() => currentCountryPhotos.filter(p => !p.isManual), [currentCountryPhotos]);
  const manualRecord = useMemo(() => currentCountryPhotos.find(p => p.isManual), [currentCountryPhotos]);
  // 只要有真实照片 OR 有手动记录，都算已点亮
  const isAreaLitUp = visiblePhotos.length > 0 || !!manualRecord;

  const showSingleMarkers = currentAltitude < 2.0;

  const htmlElementsData = useMemo(() => {
    if (isDealing) {
        const startLat = CHINA_COORDS.lat;
        const startLng = CHINA_COORDS.lng;
        return tourPlaylist.map((p, index) => {
            const myDelay = index * 0.05; 
            let myProgress = (dealProgress - myDelay) * 1.5;
            myProgress = Math.max(0, Math.min(1, myProgress));
            const curLat = startLat + (p.lat - startLat) * myProgress;
            const curLng = startLng + (p.lng - startLng) * myProgress;
            return { ...p, lat: curLat, lng: curLng, isDealingCard: true, scale: 0.2 + 0.8 * myProgress, opacity: myProgress };
        });
    }
    if (showMarkers) {
        return filteredMarkers.filter(m => m.isCluster || showSingleMarkers);
    }
    return [];
  }, [isDealing, dealProgress, tourPlaylist, showMarkers, filteredMarkers, showSingleMarkers]);

  const countryInfo = selectedCountry ? getCountryInfo(selectedCountry.properties.ADMIN || selectedCountry.properties.name) : {};
  const isProvince = selectedCountry && isChinaRegion(selectedCountry);
  const handleSwitchToChina = () => { const chinaFeature = polygonsData.find(p => p.properties.ADMIN === 'China' || p.properties.name === 'China'); const target = chinaFeature || { properties: { ADMIN: 'China', name: 'China', isChina: true } }; handleCountryClick(target); };

  const throttledSetHover = useMemo(() => throttle(setHoverD, 80), []);

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative', background: '#000' }}>
      
      <input type="file" multiple accept="image/*" ref={globalFileInputRef} style={{ display: 'none' }} onChange={(e) => processUploadedFiles(e, false)} />
      <input type="file" multiple accept="image/*" ref={localFileInputRef} style={{ display: 'none' }} onChange={(e) => processUploadedFiles(e, true)} />

      <div className="left-controls">
        <button className={`menu-hamburger-btn ${isMenuOpen ? 'active' : ''}`} onClick={() => setIsMenuOpen(!isMenuOpen)}>{isMenuOpen ? '✕' : '☰'}</button>
        <div className={`control-list ${isMenuOpen ? 'open' : ''}`}>
          <button className={`circle-btn btn-play ${isRotating && !isTouring ? 'playing' : ''}`} onClick={toggleRotation} title="自动旋转">{isRotating ? '⏸' : '▶'}</button>
          <button className="circle-btn" onClick={() => globalFileInputRef.current.click()} title="导入">📷</button>
          <button className="circle-btn btn-delete" onClick={handleClearAll} title="清空">🗑️</button>
          <button className="circle-btn" onClick={resetView} title="重置">🌏</button>
          <button className={`circle-btn ${isDayMode ? 'active' : ''}`} onClick={() => setIsDayMode(!isDayMode)} title="日夜切换">{isDayMode ? '☀️' : '🔦'}</button>
          <button className={`circle-btn ${showMarkers ? 'active' : ''}`} onClick={() => setShowMarkers(!showMarkers)} title="显示照片标记">🖼️</button>
          <button className={`circle-btn ${showStats ? 'active' : ''}`} onClick={() => { setShowStats(!showStats); if (!showStats) setSelectedCountry(null); }} title="足迹统计" style={{ borderColor: showStats ? '#FFD700' : '' }}>📊</button>
        </div>
      </div>

      <Globe
        ref={globeEl}
        onGlobeReady={handleGlobeReady}
        globeImageUrl={assetUrl('earth.jpg')}
        bumpImageUrl={assetUrl('topology.png')}
        backgroundImageUrl={isDayMode ? null : assetUrl('night.png')}
        backgroundColor={isDayMode ? "#d4e6ff" : "#040d21"}
        atmosphereColor="rgb(200, 230, 255)"
        atmosphereAltitude={0.15}
        polygonsData={polygonsData}
        polygonsTransitionDuration={300}
        onPolygonHover={throttledSetHover}
        onPolygonClick={handleCountryClick}
        onGlobeClick={() => { setSelectedCountry(null); if (isTouring) stopTour(); }}
        polygonStrokeColor={polygonStrokeColor}
        polygonCapColor={polygonCapColor}
        polygonSideColor={() => 'rgba(0,0,0,0)'}
        polygonAltitude={polygonAltitude}
        htmlAltitude={baseAltitude}
        arcsData={tourArcs}
        arcColor="color"
        arcDashLength={0.4}
        arcDashGap={0.2}
        arcDashAnimateTime={1500}
        arcStroke={0.5}
        ringsData={tourRings}
        ringColor={() => '#FFD700'}
        ringMaxRadius="maxR"
        ringPropagationSpeed="propagationSpeed"
        ringRepeatPeriod="repeatPeriod"
        htmlElementsData={htmlElementsData}
        htmlLat="lat"
        htmlLng="lng"
        htmlElement={d => {
          const el = document.createElement('div');
          
          if (d.isDealingCard) {
            el.innerHTML = `<img src="${d.url}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 8px; border: 2px solid #FFD700; box-shadow: 0 0 10px rgba(255, 215, 0, 0.8); opacity: ${d.opacity}; transform: scale(${d.scale});" />`;
            el.style.pointerEvents = 'none';
            return el;
          }

          const isHighlight = isTouring && tourPlaylist[tourStep] &&
            Math.abs(d.lat - tourPlaylist[tourStep].lat) < 0.0001 &&
            Math.abs(d.lng - tourPlaylist[tourStep].lng) < 0.0001;

          if (d.isCluster) {
            el.innerHTML = `
              <div style="position: relative; width: 50px; height: 50px; cursor: pointer;">
                <img src="${d.url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 8px; border: 2px solid white; box-shadow: 0 4px 10px rgba(0,0,0,0.5);" />
                <div style="position: absolute; bottom: -6px; right: -6px; background: #ff3b30; color: white; font-size: 12px; font-weight: bold; border-radius: 10px; padding: 2px 6px; border: 1px solid white;">${d.pointCount}</div>
              </div>`;
            el.onclick = (e) => { e.stopPropagation(); handleClusterClick(d.clusterId, d.lat, d.lng); };
          } else {
            el.className = 'globe-photo-marker';
            const borderStyle = isHighlight ? '4px solid #FFD700' : '2px solid #00C2FF';
            const size = isHighlight ? '80px' : '44px';
            const zIdx = isHighlight ? '9999' : '1';
            const boxShadow = isHighlight ? '0 0 30px rgba(255, 215, 0, 0.8)' : 'none';
            el.innerHTML = `<img src="${d.url}" style="width: ${size}; height: ${size}; object-fit: cover; border-radius: 50%; border: ${borderStyle}; cursor: pointer; transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index:${zIdx}; box-shadow: ${boxShadow};" />`;
            el.onclick = (e) => { e.stopPropagation(); handleCountryClick({ properties: { ADMIN: d.countryName } }); };
          }
          return el;
        }}
      />

      {isTouring && tourPlaylist[tourStep] && (
        <div style={{
          position: 'absolute', bottom: '10%', left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(20, 20, 20, 0.9)', backdropFilter: 'blur(30px)',
          borderRadius: '24px', padding: '16px', color: '#fff',
          boxShadow: '0 20px 80px rgba(0,0,0,0.8)', zIndex: 100,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          border: '1px solid rgba(255,215,0,0.2)', animation: 'popIn 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
        }}>
          <div style={{
            position: 'relative', width: '240px', height: '180px', borderRadius: '16px', overflow: 'hidden',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)', marginBottom: '15px'
          }}>
            <img src={tourPlaylist[tourStep].url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          </div>
          <div style={{ fontSize: '12px', color: '#FFD700', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold' }}>
            JOURNEY REPLAY • {tourStep + 1}/{tourPlaylist.length}
          </div>
          <div style={{ fontSize: '24px', fontWeight: '800', margin: '4px 0', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>
            {tourPlaylist[tourStep].countryName}
          </div>
          <div style={{ fontSize: '14px', color: '#aaa' }}>
            {new Date(tourPlaylist[tourStep].timestamp).toLocaleDateString()}
          </div>
        </div>
      )}

      {selectorModalIndex !== null && tourPlaylist[selectorModalIndex] && (
        <div style={{
          position: 'absolute', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(0,0,0,0.6)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center'
        }} onClick={() => setSelectorModalIndex(null)}>
          <div style={{
            width: '500px', maxHeight: '70vh', background: '#fff', borderRadius: '20px', padding: '20px',
            display: 'flex', flexDirection: 'column', overflow: 'hidden'
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 15px 0', color: '#333' }}>选择 {tourPlaylist[selectorModalIndex].countryName} 的照片</h3>
            <div style={{ flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
              {groupedPhotos[tourPlaylist[selectorModalIndex].countryName]?.map(p => (
                <div key={p.id} onClick={() => handleSelectPhotoForPlaylist(p)}
                  style={{
                    aspectRatio: '1', borderRadius: '8px', overflow: 'hidden', cursor: 'pointer',
                    border: p.id === tourPlaylist[selectorModalIndex].id ? '3px solid #007AFF' : '1px solid #eee',
                    position: 'relative'
                  }}>
                  <img src={p.url} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  {p.id === tourPlaylist[selectorModalIndex].id && (
                    <div style={{ position: 'absolute', top: '4px', right: '4px', background: '#007AFF', color: 'white', borderRadius: '50%', width: '16px', height: '16px', fontSize: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✓</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {isEditingPlaylist && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: '450px', maxHeight: '80vh', background: '#fff', borderRadius: '24px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)', zIndex: 2000, padding: '24px',
          display: 'flex', flexDirection: 'column'
        }}>
          <h2 style={{ margin: '0 0 15px 0', fontSize: '18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>🎬 行程单确认</span>
            <span style={{ fontSize: '12px', color: '#888', fontWeight: 'normal' }}>共 {tourPlaylist.length} 个精彩瞬间</span>
          </h2>
          <div style={{ flex: 1, overflowY: 'auto', marginBottom: '20px', paddingRight: '5px' }}>
            {tourPlaylist.map((item, index) => (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', borderBottom: '1px solid #f0f0f0', background: '#fff', transition: 'background 0.2s' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <button onClick={() => handleMovePhoto(index, -1)} disabled={index === 0} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: index === 0 ? '#eee' : '#007AFF', fontSize: '12px' }}>▲</button>
                  <button onClick={() => handleMovePhoto(index, 1)} disabled={index === tourPlaylist.length - 1} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: index === tourPlaylist.length - 1 ? '#eee' : '#007AFF', fontSize: '12px' }}>▼</button>
                </div>
                <img src={item.url} style={{ width: '60px', height: '60px', borderRadius: '10px', objectFit: 'cover' }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '15px', fontWeight: 'bold', color: '#333' }}>{item.countryName}</div>
                  {editingTimeId === item.id ? (
                    <input
                      type="datetime-local"
                      defaultValue={formatForInput(item.timestamp)}
                      onBlur={(e) => handleTimeChange(item.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleTimeChange(item.id, e.target.value) }}
                      autoFocus
                      style={{ fontSize: '12px', marginTop: '4px', padding: '4px', border: '1px solid #007AFF', borderRadius: '6px' }}
                    />
                  ) : (
                    <div style={{ fontSize: '12px', color: '#888', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {new Date(item.timestamp).toLocaleString()}
                      <button onClick={() => setEditingTimeId(item.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: '12px' }}>✏️</button>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '5px' }}>
                  <button onClick={() => handleSwapPhoto(index, item.countryName)} title="换一张" style={{ border: 'none', background: '#f5f5f7', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '14px' }}>🖼️</button>
                  <button onClick={() => handleAddPhoto(index, item.countryName)} title="再加一张" style={{ border: 'none', background: '#f5f5f7', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '14px' }}>➕</button>
                  <button onClick={() => handleRemovePhotoFromPlaylist(index)} title="移除" style={{ border: 'none', background: '#fff0f0', color: '#ff3b30', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', fontSize: '14px' }}>✕</button>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setIsEditingPlaylist(false)} style={{ flex: 1, padding: '14px', borderRadius: '14px', border: 'none', background: '#f5f5f7', color: '#333', fontWeight: 'bold', cursor: 'pointer', fontSize: '15px' }}>取消</button>
            <button onClick={startTourExecution} style={{ flex: 2, padding: '14px', borderRadius: '14px', border: 'none', background: 'linear-gradient(90deg, #007AFF, #5856D6)', color: '#fff', fontWeight: 'bold', cursor: 'pointer', fontSize: '15px', boxShadow: '0 4px 15px rgba(0,122,255,0.3)' }}>开始发牌点亮 ✨</button>
          </div>
        </div>
      )}

      {showStats && !isTouring && !isEditingPlaylist && (
        <div style={{ position: 'absolute', bottom: '40px', left: '40px', width: '320px', background: 'rgba(255, 255, 255, 0.85)', backdropFilter: 'blur(20px)', borderRadius: '24px', padding: '24px', boxShadow: '0 20px 50px rgba(0,0,0,0.2)', zIndex: 20, color: '#1d1d1f', textAlign: 'center', transition: 'all 0.3s ease' }}>
          <button style={{ position: 'absolute', top: '15px', right: '15px', border: 'none', background: 'transparent', fontSize: '20px', cursor: 'pointer', color: '#888' }} onClick={() => setShowStats(false)}>×</button>
          <h2 style={{ margin: '0 0 5px 0', fontSize: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}><span>🌍</span> 我的足迹</h2>
          <p style={{ margin: '0 0 20px 0', color: '#86868b', fontSize: '13px' }}>探索世界的每一公里</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <div style={{ background: '#fff', padding: '15px', borderRadius: '16px', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: '28px', fontWeight: '800', color: '#007AFF' }}>{statsData.km.toLocaleString()} <span style={{ fontSize: '14px', fontWeight: '500' }}>km</span></div>
              <div style={{ fontSize: '12px', color: '#86868b', marginTop: '4px' }}>旅行总里程</div>
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <div style={{ flex: 1, background: '#fff', padding: '12px', borderRadius: '16px', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}><div style={{ fontSize: '20px', fontWeight: '800', color: '#1d1d1f' }}>{statsData.countries}</div><div style={{ fontSize: '11px', color: '#86868b', marginTop: '4px' }}>国家/地区</div></div>
              <div style={{ flex: 1, background: '#fff', padding: '12px', borderRadius: '16px', boxShadow: '0 4px 10px rgba(0,0,0,0.05)' }}><div style={{ fontSize: '20px', fontWeight: '800', color: '#FF9500' }}>{statsData.provinces}</div><div style={{ fontSize: '11px', color: '#86868b', marginTop: '4px' }}>中国省市</div></div>
            </div>
            <button onClick={prepareTourPlaylist} disabled={photos.length === 0} style={{ background: 'linear-gradient(90deg, #007AFF, #5856D6)', color: '#fff', border: 'none', padding: '12px', borderRadius: '14px', fontSize: '14px', fontWeight: '600', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,122,255,0.3)', marginTop: '5px', opacity: photos.length === 0 ? 0.5 : 1 }}>🎥 演示点亮过程</button>
          </div>
        </div>
      )}

      <div className={`info-panel ${selectedCountry ? 'active' : ''}`} style={{ zIndex: 9999 }}>
        <div className="panel-content" style={{ position: 'relative' }}>
          {selectedCountry && (
            <>
              <div className="panel-header">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h1 style={{ margin: 0 }}>{countryInfo.cnName}</h1>
                  {isProvince && !isSelectedCountryChina && (
                    <button onClick={handleSwitchToChina} style={{ fontSize: '12px', color: '#007AFF', background: 'rgba(0,122,255,0.1)', border: 'none', padding: '6px 12px', borderRadius: '14px', cursor: 'pointer', fontWeight: '600', transition: 'all 0.2s', marginLeft: '10px', whiteSpace: 'nowrap' }} onMouseOver={(e) => e.target.style.background = 'rgba(0,122,255,0.2)'} onMouseOut={(e) => e.target.style.background = 'rgba(0,122,255,0.1)'}>查看中国 →</button>
                  )}
                </div>
                <div className="panel-subtitle" style={{ marginTop: '4px' }}>{(isProvince && !isSelectedCountryChina) ? '中国 / 行政区' : '世界 / 国家地区'}</div>
              </div>

              <div className="stats-container">
                <div className="stat-row"><span className="stat-label">行政中心</span><span className="stat-value">{countryInfo.capital}</span></div>
                <div className="stat-row"><span className="stat-label">人口</span><span className="stat-value">{countryInfo.pop}</span></div>
                <div className="stat-row"><span className="stat-label">GDP</span><span className="stat-value">{countryInfo.gdp}</span></div>
              </div>
              <div className="desc-box">{countryInfo.desc}</div>

              {/* 🔥 新增状态栏：如果是手动点亮，显示此状态条 */}
              {manualRecord && (
                <div style={{ margin: '15px 0', padding: '12px', background: '#F2F2F7', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid #E5E5EA' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '18px' }}>🌟</span>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#1d1d1f' }}>已成功点亮此地</span>
                  </div>
                  <button onClick={(e) => handleDeletePhoto(manualRecord.id, e)} style={{ border: 'none', background: '#fff', color: '#FF3B30', fontSize: '12px', padding: '6px 12px', borderRadius: '8px', cursor: 'pointer', boxShadow: '0 2px 5px rgba(0,0,0,0.05)' }}>取消点亮</button>
                </div>
              )}

              <div className="gallery-header" style={{ display: 'flex', alignItems: 'center', marginBottom: '12px' }}>
                <span className="gallery-title" style={{ fontSize: '15px', fontWeight: '600', color: '#1d1d1f' }}>在此地的足迹</span>
                {visiblePhotos.length > 0 && (<span style={{ fontSize: '13px', color: '#86868b', marginLeft: '6px', fontWeight: 'normal' }}>({visiblePhotos.length})</span>)}
              </div>

              {/* 🔥 只显示真实照片，手动记录已被 visiblePhotos 过滤 */}
              {visiblePhotos.length > 0 ? (
                <div className="photo-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
                  <div onClick={() => localFileInputRef.current.click()} style={{ position: 'relative', borderRadius: '10px', overflow: 'hidden', aspectRatio: '1', background: '#F5F5F7', border: '1px dashed #C1C1C4', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background 0.2s' }} onMouseOver={(e) => e.currentTarget.style.background = '#E5E5EA'} onMouseOut={(e) => e.currentTarget.style.background = '#F5F5F7'}>
                    <span style={{ fontSize: '24px', color: '#007AFF', fontWeight: '300' }}>+</span>
                  </div>
                  {visiblePhotos.map(photo => (
                    <div key={photo.id} className="photo-item" style={{ position: 'relative', borderRadius: '10px', overflow: 'hidden', aspectRatio: '1' }}>
                      <img src={photo.url} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      <button className="photo-delete-btn" onClick={(e) => handleDeletePhoto(photo.id, e)} style={{ position: 'absolute', top: '4px', right: '4px', background: 'rgba(0,0,0,0.4)', border: 'none', color: '#fff', borderRadius: '50%', width: '22px', height: '22px', cursor: 'pointer', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state" style={{ textAlign: 'center', color: '#86868b', marginTop: '20px' }}>
                  {isAreaLitUp ? (
                     <p>暂无照片记录，但已为您点亮 ✨</p>
                  ) : (
                     <p>该地区暂无足迹</p>
                  )}
                  
                  <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '15px' }}>
                    <button className="small-upload-btn" onClick={() => localFileInputRef.current.click()} style={{ padding: '8px 14px', borderRadius: '12px', background: '#007AFF', color: '#fff', border: 'none', cursor: 'pointer' }}>📷 上传照片</button>
                    
                    {/* 🔥 只有未点亮时才显示“一键点亮”按钮 */}
                    {!isAreaLitUp && (
                        <button className="small-upload-btn" onClick={handleManualLightUp} style={{ padding: '8px 14px', borderRadius: '12px', background: '#34C759', color: '#fff', border: 'none', cursor: 'pointer' }}>✨ 一键点亮</button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <button className="close-btn" onClick={() => setSelectedCountry(null)} style={{ position: 'absolute', top: '12px', right: '12px', border: 'none', background: 'transparent', fontSize: '22px', cursor: 'pointer' }}>×</button>
      </div>

      <style>{`
        .info-panel { position: absolute; right: 0; top: 0; bottom: 0; width: 360px; background: linear-gradient(180deg, rgba(255,255,255,0.96), rgba(250,250,250,0.9)); padding: 20px; box-shadow: -20px 0 40px rgba(0,0,0,0.25); }
        .panel-content { height: 100%; overflow: auto; }
        .panel-header h1 { margin: 0; font-size: 20px; }
        @keyframes popIn { 0% { opacity: 0; transform: translate(-50%, 20px) scale(0.9); } 100% { opacity: 1; transform: translate(-50%, 0) scale(1); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

export default App;
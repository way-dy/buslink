// 정류장 사진용 클라이언트 이미지 리사이즈·압축 헬퍼.
// Firebase Storage 미사용 — 압축한 data URI 문자열을 Firestore 정류장 문서에 직접 저장.
// 추가 의존성 없이 canvas만 사용(EXIF 회전 미보정 — canvas 기본 방향).

const MAX_EDGE = 1000;          // 긴 변 최대 px
const QUALITY_STEPS = [0.6, 0.45, 0.3]; // JPEG 품질 단계 재압축
const SOFT_LIMIT = 500 * 1024;  // 이 이하면 통과(base64 문자열 기준)
const HARD_LIMIT = 700 * 1024;  // 이 초과면 거부(Firestore 1MB 문서 한도 안전 여유)

// File → 압축 data URI(JPEG). 너무 크면 reject.
// 반환: { dataUri, bytes }  / 거부: throw Error(메시지는 사용자에게 그대로 노출 가능)
export function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) {
      reject(new Error("이미지 파일만 첨부할 수 있습니다")); return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        let { width, height } = img;
        if (width > height && width > MAX_EDGE) { height = Math.round(height * MAX_EDGE / width); width = MAX_EDGE; }
        else if (height >= width && height > MAX_EDGE) { width = Math.round(width * MAX_EDGE / height); height = MAX_EDGE; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height); // 투명 PNG 대비 흰 배경
        ctx.drawImage(img, 0, 0, width, height);
        // 품질 단계적으로 낮춰가며 SOFT_LIMIT 이하 시도
        let dataUri = "";
        for (const q of QUALITY_STEPS) {
          dataUri = canvas.toDataURL("image/jpeg", q);
          if (dataUri.length <= SOFT_LIMIT) break;
        }
        if (dataUri.length > HARD_LIMIT) {
          reject(new Error("사진 용량이 큽니다 — 더 작은 이미지를 사용하세요")); return;
        }
        resolve({ dataUri, bytes: dataUri.length });
      } catch (e) {
        reject(new Error("이미지 처리 중 오류가 발생했습니다 — 다른 이미지를 사용하세요"));
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지를 읽을 수 없습니다 — 다른 파일을 사용하세요")); };
    img.src = url;
  });
}

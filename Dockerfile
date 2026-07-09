# Dockerfile สำหรับ deploy บน Railway (build จาก root ของ repo)
FROM node:20-alpine

WORKDIR /app

# ติดตั้ง dependency (pg) ก่อน เพื่อใช้ layer cache
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# คัดลอกโค้ดทั้งหมดเข้า image
COPY . .

# Railway จะกำหนดค่า PORT และ DATABASE_URL ให้ผ่าน environment variable
# server.js อ่านค่าเหล่านี้อยู่แล้ว
CMD ["node", "registration-system/server.js"]

# Dockerfile สำหรับ deploy บน Railway (build จาก root ของ repo)
# แอพนี้ไม่มี dependency ภายนอก จึงไม่ต้อง npm install
FROM node:20-alpine

WORKDIR /app

# คัดลอกโค้ดทั้งหมดเข้า image
COPY . .

# Railway จะกำหนดค่า PORT ให้ผ่าน environment variable โดยอัตโนมัติ
# server.js อ่านค่า process.env.PORT อยู่แล้ว
CMD ["node", "registration-system/server.js"]

# Chat de influencers (Node.js + Socket.IO + MySQL)
# Railway construye esta imagen y le pasa las variables (PORT, DB_*, API_KEY, etc.).

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencias primero: si no cambia package*.json, Docker reutiliza esta capa
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Fotos de los clientes. En Railway, monta aquí un volumen (/app/uploads) para que no se borren al redesplegar.
# Se ejecuta como root a propósito: los volúmenes de Railway se montan como root y "node" no podría escribir en ellos.
RUN mkdir -p uploads

# Railway define PORT; en local se usa 3000
EXPOSE 3000

CMD ["node", "server.js"]

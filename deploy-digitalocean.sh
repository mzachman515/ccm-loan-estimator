#!/bin/bash
set -e
echo "=== CCM Loan Estimator - DigitalOcean Setup ==="

# Clean any previous failed install
systemctl stop ccm 2>/dev/null || true
rm -rf /opt/ccm

# Install Node.js 20 (skip if already installed)
if ! command -v node &>/dev/null || [[ $(node -v) != v20* ]]; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Install git and nginx
apt-get install -y git nginx

# Clone and build
echo "Cloning repository..."
mkdir -p /opt/ccm
cd /opt/ccm
git clone https://github.com/mzachman515/ccm-loan-estimator.git app
cd app

echo "Installing dependencies..."
npm install --production=false

echo "Building app..."
npm run build

# Create systemd service
echo "Setting up service..."
cat > /etc/systemd/system/ccm.service << 'EOF'
[Unit]
Description=CCM Loan Estimator
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ccm/app
ExecStart=/usr/bin/node dist/index.cjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=5000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ccm
systemctl start ccm

# Wait for app to start
sleep 3

# Configure Nginx
echo "Setting up Nginx..."
cat > /etc/nginx/sites-available/default << 'EOF'
server {
    listen 80;
    server_name _;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_connect_timeout 10s;
    }
}
EOF

nginx -t && systemctl restart nginx

# Verify
echo ""
echo "Checking app status..."
systemctl status ccm --no-pager -l | head -15
echo ""

IP=$(curl -s ifconfig.me)
echo "======================================="
echo "  DEPLOYMENT COMPLETE"
echo "  App is live at: http://$IP"
echo "======================================="
echo ""
echo "To update later:"
echo "  cd /opt/ccm/app && git pull && npm install && npm run build && systemctl restart ccm"

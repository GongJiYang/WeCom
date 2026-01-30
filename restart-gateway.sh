#!/bin/bash
# WeCom Gateway 重启脚本
# 用于重新构建、停止旧进程、启动新进程并验证

set -e

cd /opt || exit 1

echo "=========================================="
echo "WeCom Gateway 重启脚本"
echo "=========================================="
echo ""

# 步骤 1: 构建项目
echo "[1/5] 构建项目..."
if pnpm build 2>&1 | tail -20; then
    echo "✓ 构建成功"
else
    echo "✗ 构建失败"
    exit 1
fi
echo ""

# 步骤 2: 停止旧进程
echo "[2/5] 停止旧 Gateway 进程..."
OLD_PIDS=$(pgrep -f "clawdbot.*gateway" || true)
if [ -n "$OLD_PIDS" ]; then
    echo "找到进程: $OLD_PIDS"
    pkill -9 -f "clawdbot.*gateway" || true
    sleep 2
    echo "✓ 旧进程已停止"
else
    echo "✓ 没有运行中的进程"
fi
echo ""

# 步骤 3: 验证端口已释放
echo "[3/5] 验证端口 18789 已释放..."
if ss -ltnp 2>/dev/null | grep -q ":18789"; then
    echo "✗ 端口 18789 仍被占用，请先释放后再运行"
    ss -ltnp | grep ":18789"
    exit 1
else
    echo "✓ 端口已释放"
fi
echo ""

# 步骤 4: 启动新进程
echo "[4/5] 启动新 Gateway 进程..."
nohup pnpm clawdbot gateway run --bind 0.0.0.0 --port 18789 --force > /tmp/clawdbot-gateway.log 2>&1 &
GATEWAY_PID=$!
echo "Gateway PID: $GATEWAY_PID"
sleep 5
echo ""

# 步骤 5: 验证启动
echo "[5/5] 验证 Gateway 启动状态..."
echo ""

LOG_FILE="/tmp/clawdbot/clawdbot-$(date +%Y-%m-%d).log"

# 检查端口（nohup 后 $! 可能是 pnpm，子进程才是 gateway，以端口为准）
if ss -ltnp 2>/dev/null | grep -q ":18789"; then
    echo "✓ 端口 18789 正在监听"
    ss -ltnp | grep ":18789"
else
    echo "✗ 端口 18789 未监听，检查日志:"
    tail -n 30 /tmp/clawdbot-gateway.log
    exit 1
fi

# 检查 gateway 进程是否存在
if pgrep -f "clawdbot-gateway" > /dev/null 2>&1; then
    echo "✓ Gateway 进程运行中"
else
    echo "⚠ 未找到 clawdbot-gateway 进程，请确认: tail -n 50 /tmp/clawdbot-gateway.log"
fi

# 检查日志中的启动信息（使用当天日志）
echo ""
echo "检查启动日志..."
if [ -f "$LOG_FILE" ] && tail -n 100 "$LOG_FILE" 2>/dev/null | grep -q "listening on ws://"; then
    echo "✓ Gateway 启动成功"
    tail -n 100 "$LOG_FILE" | grep -i -E "listening|PID|wecom.*starting|wecom.*registered" | tail -5
else
    echo "⚠ 未在 $LOG_FILE 找到启动行，可查看: tail -n 50 $LOG_FILE"
fi

echo ""
echo "=========================================="
echo "重启完成！"
echo "=========================================="
echo ""
echo "查看日志:"
echo "  tail -f $LOG_FILE | grep --line-buffered -i wecom"
echo ""
echo "测试 webhook:"
echo "  curl -X POST http://127.0.0.1:18789/webhook/wecom/default -H 'Content-Type: application/xml' -d '<xml><Encrypt>test</Encrypt></xml>'"
echo ""

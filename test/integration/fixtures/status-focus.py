import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time


with tempfile.TemporaryDirectory(prefix="garden-focus-test-") as tmp:
    socket = tmp + "/tmux.sock"
    env = dict(os.environ, TERM="xterm-256color")
    env.pop("TMUX", None)

    def tmux(*args):
        return subprocess.check_output(
            ["tmux", "-S", socket, *args], env=env, stderr=subprocess.STDOUT
        ).decode().strip()

    def drain(fd, duration=0.2):
        output = b""
        end = time.monotonic() + duration
        while time.monotonic() < end:
            if select.select([fd], [], [], max(0, end - time.monotonic()))[0]:
                output += os.read(fd, 65536)
        return output

    pid = None
    try:
        tmux("-f", "/dev/null", "new-session", "-d", "-s", "garden-dashboard",
             "-n", "main", "/bin/cat")
        for command in json.loads(sys.argv[1]):
            tmux(*command)
        tmux("set-option", "-t", "garden-dashboard", "status-interval", "0")
        tmux("set-option", "-t", "garden-dashboard", "status-left", "garden")
        pid, fd = pty.fork()
        if pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
            os.execvpe("tmux", ["tmux", "-S", socket, "attach-session",
                               "-t", "garden-dashboard"], env)
        drain(fd)
        # Answer terminal identification so tmux enables focus reporting.
        os.write(fd, b"\x1b[?1;2c\x1b[>0;276;0c")
        drain(fd)
        client = tmux("list-clients", "-F", "#{client_name}")
        assert client, "test terminal did not attach"
        for style, color in zip(json.loads(sys.argv[2]), ["green", "yellow", "green"]):
            tmux("set-option", "-t", "garden-dashboard", "status-style", style)
            os.write(fd, b"\x1b[I")
            drain(fd)
            focused = tmux("display-message", "-p", "-c", client, "#{E:status-style}")
            assert focused == "bg=" + color + ",fg=black", focused
            for event, expected, escape in [
                (b"\x1b[O", "bg=colour236,fg=colour244", b"\x1b[48;5;236m"),
                (b"\x1b[I", "bg=" + color + ",fg=black",
                 b"\x1b[42m" if color == "green" else b"\x1b[43m"),
            ]:
                os.write(fd, event)
                redraw = drain(fd, 0.5)
                resolved = tmux("display-message", "-p", "-c", client, "#{E:status-style}")
                assert resolved == expected, resolved
                assert escape in redraw, "focus change did not repaint: " + repr(redraw)
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if pid:
            os.waitpid(pid, 0)
            os.close(fd)

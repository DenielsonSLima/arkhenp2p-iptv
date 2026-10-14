"""Local PTY regression: uses invalid synthetic input, never loads Frida."""
import os
import pty
import select
import subprocess
import sys
import termios
import time
import unittest
from pathlib import Path


class LoginTransportTest(unittest.TestCase):
    def test_tty_input_is_not_echoed_and_terminal_is_restored(self):
        master, slave = pty.openpty()
        initial = termios.tcgetattr(slave)
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).with_name('login.py')), '--endpoint', '127.0.0.1:27043'],
            stdin=slave, stdout=slave, stderr=slave,
        )
        output = b''
        try:
            deadline = time.monotonic() + 3
            while b'input-ready' not in output and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output += os.read(master, 4096)
            self.assertIn(b'input-ready', output)
            self.assertFalse(termios.tcgetattr(slave)[3] & termios.ECHO)
            os.write(master, b'{"password":"SYNTHETIC_PRIVATE_MARKER","invalid":true}\n')
            process.wait(timeout=3)
            while select.select([master], [], [], 0.05)[0]:
                output += os.read(master, 4096)
            self.assertNotIn(b'SYNTHETIC_PRIVATE_MARKER', output)
            self.assertIn(b'LOGIN_INVALID_INPUT', output)
            self.assertEqual(termios.tcgetattr(slave)[3], initial[3])
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    unittest.main()

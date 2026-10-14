import unittest
from types import SimpleNamespace

from client import PACKAGE, application_pid, error_code, cleanup_attachment


class ApplicationPidTests(unittest.TestCase):
    def device(self, applications):
        return SimpleNamespace(enumerate_applications=lambda: applications)

    def app(self, identifier=PACKAGE, pid=2259, name='WPlay'):
        return SimpleNamespace(identifier=identifier, pid=pid, name=name)

    def test_label_may_differ_but_package_must_match_exactly(self):
        apps = [self.app(identifier=PACKAGE + '.other', pid=123), self.app()]
        self.assertEqual(application_pid(self.device(apps)), 2259)

    def test_installed_but_stopped_is_not_attached(self):
        with self.assertRaisesRegex(ValueError, 'ENGINE_PROCESS_NOT_RUNNING'):
            application_pid(self.device([self.app(pid=0)]))

    def test_label_alone_cannot_select_another_package(self):
        with self.assertRaisesRegex(ValueError, 'ENGINE_PROCESS_NOT_RUNNING'):
            application_pid(self.device([self.app(identifier='other.app')]))

    def test_ambiguous_match_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'ENGINE_PROCESS_AMBIGUOUS'):
            application_pid(self.device([self.app(), self.app(pid=2260)]))

    def test_error_output_does_not_include_exception_details(self):
        error = ValueError('ENGINE_PROCESS_NOT_RUNNING private-diagnostic')
        self.assertEqual(error_code(error), 'ENGINE_PROCESS_NOT_RUNNING')


class CleanupTests(unittest.TestCase):
    def fixtures(self, request='owned'):
        calls = []
        exports = SimpleNamespace(status=lambda: {'requestId': request},
                                  stop=lambda request: calls.append('stop:' + request),
                                  detach=lambda: calls.append('restore-hooks'))
        script = SimpleNamespace(unload=lambda: calls.append('unload-script'))
        session = SimpleNamespace(detach=lambda: calls.append('detach-session'))
        return calls, exports, script, session

    def test_restores_observers_before_unloading_runtime(self):
        calls, exports, script, session = self.fixtures()
        cleanup_attachment(exports, script, session, 'owned')
        self.assertEqual(calls, ['stop:owned', 'restore-hooks', 'unload-script', 'detach-session'])

    def test_never_stops_playback_owned_by_original_ui_or_another_request(self):
        calls, exports, script, session = self.fixtures('other')
        cleanup_attachment(exports, script, session, 'owned')
        self.assertEqual(calls, ['restore-hooks', 'unload-script', 'detach-session'])

    def test_normal_detach_is_not_repeated(self):
        calls, exports, script, session = self.fixtures()
        cleanup_attachment(exports, script, session, already_detached=True)
        self.assertEqual(calls, ['unload-script', 'detach-session'])

    def test_stop_error_still_restores_hooks_without_exposing_exception(self):
        calls, exports, script, session = self.fixtures()
        def stop(_):
            raise RuntimeError('private-diagnostic')
        exports.stop = stop
        cleanup_attachment(exports, script, session, 'owned')
        self.assertEqual(calls, ['restore-hooks', 'unload-script', 'detach-session'])


if __name__ == '__main__':
    unittest.main()

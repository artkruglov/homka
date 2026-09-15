import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import Mock
from server import handler


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.engine = Mock()
        self.engine.transcribe.return_value = 'проверка'
        self.server = ThreadingHTTPServer(('127.0.0.1',0),handler(self.engine,'test-secret'))
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, body=b'OggSOpusHeadtest', auth='Bearer test-secret'):
        client=http.client.HTTPConnection(*self.server.server_address)
        client.request('POST','/transcribe',body,{'Authorization':auth,'Content-Type':'audio/ogg'})
        result=client.getresponse()
        value=(result.status,result.read())
        client.close()
        return value

    def test_auth_before_inference(self):
        self.assertEqual(self.request(auth='wrong')[0],401)
        self.engine.transcribe.assert_not_called()

    def test_invalid_audio_before_inference(self):
        self.assertEqual(self.request(body=b'not audio')[0],422)
        self.engine.transcribe.assert_not_called()

    def test_transcribes_once(self):
        self.assertEqual(self.request()[0],200)
        self.engine.transcribe.assert_called_once()

    def test_duration_limit_and_recovery(self):
        self.engine.transcribe.side_effect=OverflowError()
        self.assertEqual(self.request()[0],413)
        self.engine.transcribe.side_effect=None
        self.assertEqual(self.request()[0],200)

if __name__=='__main__': unittest.main()

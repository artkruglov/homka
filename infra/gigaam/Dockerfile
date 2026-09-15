FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84
ARG GIGAAM_REVISION=7447938d791c4f3e643386ee22c33777004293a5
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir "gigaam @ git+https://github.com/salute-developers/GigaAM.git@${GIGAAM_REVISION}"
RUN mkdir /models && python -c "import gigaam; gigaam.load_model('multilingual_ctc',device='cpu',download_root='/models')" && chmod -R a+rX /models
WORKDIR /service
COPY server.py test_server.py ./
RUN python -m unittest test_server.py
USER 65532:65532
CMD ["python","server.py"]

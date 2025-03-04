FROM python:3.8.2-slim-buster

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
                  # building packages
                  bzip2 ccache clang-format-6.0 cmake f2c g++ gfortran git make \
                  patch pkg-config swig unzip wget xz-utils \
                  # testing packages: libgconf-2-4 is necessary for running chromium
                  libgconf-2-4 "chromium=90.*" \
  && rm -rf /var/lib/apt/lists/*

RUN pip3 --no-cache-dir install \
  black \
  "cython<3.0" \
  packaging \
  flake8 \
  hypothesis \
  "mypy==0.812" \
  pytest \
  pytest-cov \
  pytest-httpserver \
  pytest-instafail \
  pytest-rerunfailures \
  pytest-xdist \
  pyyaml \
  "selenium==4.0.0.b3" \
  python-minifier

# Get firefox 70.0.1 and geckodriver
RUN wget -qO- https://ftp.mozilla.org/pub/firefox/releases/87.0/linux-x86_64/en-US/firefox-87.0.tar.bz2 | tar jx \
  && ln -s $PWD/firefox/firefox /usr/local/bin/firefox \
  && wget -qO- https://github.com/mozilla/geckodriver/releases/download/v0.29.1/geckodriver-v0.29.1-linux64.tar.gz | tar zxC /usr/local/bin/

# Get recent version of chromedriver
RUN wget --quiet https://chromedriver.storage.googleapis.com/89.0.4389.23/chromedriver_linux64.zip \
  && unzip chromedriver_linux64.zip \
  && mv $PWD/chromedriver /usr/local/bin \
  && rm -f chromedriver_linux64.zip

CMD ["/bin/sh"]
WORKDIR /src
